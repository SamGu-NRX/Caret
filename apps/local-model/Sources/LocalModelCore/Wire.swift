import Foundation

/// One completion request: a JSON object on one line of stdin.
public struct Request: Equatable, Sendable {
    public let id: String
    /// Text the tool decodes once and keeps: a later request with the same prefix restores its state instead of
    /// decoding it again. Empty for no reuse.
    public let prefix: String
    /// Text decoded after the prefix, every time.
    public let prompt: String
    /// A GBNF grammar whose `root` rule is the only language the output can be in.
    public let grammar: String
    public let maxTokens: Int

    public init(id: String, prefix: String = "", prompt: String, grammar: String, maxTokens: Int) {
        self.id = id
        self.prefix = prefix
        self.prompt = prompt
        self.grammar = grammar
        self.maxTokens = maxTokens
    }

    /// Output cap a request may ask for. The intent's longest answer is about 150 tokens; this only bounds a typo.
    public static let maxTokensLimit = 2048
    static let keys: Set<String> = ["id", "prefix", "prompt", "grammar", "maxTokens"]
}

/// Why a line is not a request. The message names the key and what was wrong with it.
public struct RequestError: Error, Equatable, CustomStringConvertible {
    public let id: String?
    public let description: String

    public init(id: String?, description: String) {
        self.id = id
        self.description = description
    }
}

/// Parses one line strictly: every key known, every type exact, grammar and prompt non-empty.
public func parseRequest(_ line: Data) -> Result<Request, RequestError> {
    guard let any = try? JSONSerialization.jsonObject(with: line), let o = any as? [String: Any] else {
        return .failure(RequestError(id: nil, description: "the line is not a JSON object"))
    }
    let id = o["id"] as? String
    func fail(_ m: String) -> Result<Request, RequestError> { .failure(RequestError(id: id, description: m)) }
    if let unknown = o.keys.sorted().first(where: { !Request.keys.contains($0) }) { return fail("unknown key '\(unknown)'") }
    guard let id, !id.isEmpty else { return fail("'id' must be a non-empty string") }
    let prefix: String
    switch o["prefix"] {
    case nil: prefix = ""
    case let s as String: prefix = s
    default: return fail("'prefix' must be a string")
    }
    guard let prompt = o["prompt"] as? String, !prompt.isEmpty else { return fail("'prompt' must be a non-empty string") }
    guard let grammar = o["grammar"] as? String, !grammar.isEmpty else { return fail("'grammar' must be a non-empty string") }
    // JSONSerialization reads 3 and 3.0 alike as NSNumber; a Bool is an NSNumber too, so check its type.
    guard let n = o["maxTokens"] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.rounded() == n.doubleValue,
          n.doubleValue >= 1, n.doubleValue <= Double(Request.maxTokensLimit)
    else { return fail("'maxTokens' must be an integer from 1 to \(Request.maxTokensLimit)") }
    return .success(Request(id: id, prefix: prefix, prompt: prompt, grammar: grammar, maxTokens: Int(n.doubleValue)))
}

/// Megabytes (2^20 bytes) of this process, from proc_pid_rusage.
public struct MemoryUse: Encodable, Equatable, Sendable {
    /// Resident pages, the model's mapped file pages included.
    public let residentMB: Double
    /// What macOS charges the process (Activity Monitor's Memory): anonymous and GPU memory, not clean file pages.
    public let footprintMB: Double
    /// The kernel's lifetime maximum footprint, raised to the current footprint when it lags behind it: the kernel
    /// updates that maximum only now and then, and one G1 `swift test` run read a peak below the live footprint.
    public let peakFootprintMB: Double
    /// getrusage's maximum resident set size.
    public let peakResidentMB: Double

    public init(residentMB: Double, footprintMB: Double, peakFootprintMB: Double, peakResidentMB: Double) {
        self.residentMB = residentMB
        self.footprintMB = footprintMB
        self.peakFootprintMB = peakFootprintMB
        self.peakResidentMB = peakResidentMB
    }

    public static func now() -> MemoryUse {
        let mb = { (b: UInt64) in (Double(b) / 1_048_576 * 10).rounded() / 10 }
        var ri = rusage_info_v4()
        let rc = withUnsafeMutablePointer(to: &ri) { p in
            p.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(getpid(), RUSAGE_INFO_V4, $0) }
        }
        var ru = rusage()
        getrusage(RUSAGE_SELF, &ru)
        guard rc == 0 else { return MemoryUse(residentMB: -1, footprintMB: -1, peakFootprintMB: -1, peakResidentMB: mb(UInt64(ru.ru_maxrss))) }
        let peak = max(ri.ri_lifetime_max_phys_footprint, ri.ri_phys_footprint)
        return MemoryUse(residentMB: mb(ri.ri_resident_size), footprintMB: mb(ri.ri_phys_footprint), peakFootprintMB: mb(peak), peakResidentMB: mb(UInt64(ru.ru_maxrss)))
    }
}

public struct Timing: Encodable, Equatable, Sendable {
    /// Decoding the prefix, or restoring its saved state when cached.
    public let prefix: Double
    public let prompt: Double
    public let decode: Double
    public let total: Double

    public init(prefix: Double, prompt: Double, decode: Double, total: Double) {
        self.prefix = prefix
        self.prompt = prompt
        self.decode = decode
        self.total = total
    }
}

public enum Stop: String, Encodable, Sendable {
    /// The model ended, which the grammar allows only once its root is complete.
    case eog
    /// The cap ran out first: the text may be an unfinished sentence of the grammar.
    case maxTokens
}

public struct Completion: Encodable, Equatable, Sendable {
    public let id: String
    public let ok = true
    public let text: String
    public let stop: Stop
    public let prefixTokens: Int
    public let prefixCached: Bool
    public let promptTokens: Int
    public let outputTokens: Int
    public let ms: Timing
    public let memory: MemoryUse

    public init(id: String, text: String, stop: Stop, prefixTokens: Int, prefixCached: Bool, promptTokens: Int, outputTokens: Int, ms: Timing, memory: MemoryUse) {
        self.id = id
        self.text = text
        self.stop = stop
        self.prefixTokens = prefixTokens
        self.prefixCached = prefixCached
        self.promptTokens = promptTokens
        self.outputTokens = outputTokens
        self.ms = ms
        self.memory = memory
    }

    private enum CodingKeys: String, CodingKey { case id, ok, text, stop, prefixTokens, prefixCached, promptTokens, outputTokens, ms, memory }
}

public struct Failure: Encodable, Equatable, Sendable {
    public let id: String?
    public let ok = false
    public let error: String

    public init(id: String?, error: String) {
        self.id = id
        self.error = error
    }

    private enum CodingKeys: String, CodingKey { case id, ok, error }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        // A null id says the line could not be tied to a request.
        try c.encode(id, forKey: .id)
        try c.encode(ok, forKey: .ok)
        try c.encode(error, forKey: .error)
    }
}

/// The first line the tool writes: the model loaded, or why not.
public struct Ready: Encodable, Equatable, Sendable {
    public let ready = true
    public let model: String
    public let loadMs: Double
    public let nCtx: Int
    public let memory: MemoryUse

    public init(model: String, loadMs: Double, nCtx: Int, memory: MemoryUse) {
        self.model = model
        self.loadMs = loadMs
        self.nCtx = nCtx
        self.memory = memory
    }

    private enum CodingKeys: String, CodingKey { case ready, model, loadMs, nCtx, memory }
}

public struct NotReady: Encodable, Equatable, Sendable {
    public let ready = false
    public let error: String

    public init(error: String) { self.error = error }

    private enum CodingKeys: String, CodingKey { case ready, error }
}

/// One JSON object and its newline. JSONEncoder escapes every newline inside strings, so a response is one line.
public func encodeLine<T: Encodable>(_ value: T) -> Data {
    let e = JSONEncoder()
    e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    // Every type here encodes plain strings, numbers and bools; a failure is a programming error.
    var d = try! e.encode(value)
    d.append(0x0A)
    return d
}
