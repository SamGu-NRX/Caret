// caret-bridge: the Native Messaging host Chrome (or Chrome for Testing, or Helium) launches for Caret's extension.
// Chrome runs it with the calling extension's origin as its first argument and talks to it over stdin and stdout
// in Native Messaging frames. It connects to the helper's page.sock, refuses a listener that is not this user
// (getpeereid), proves it holds the helper's per-start secret and requires the helper to prove the same
// (CaretPageProtocol/Auth.swift), then relays: frames from the extension become NDJSON lines to the helper, lines
// from the helper become frames, split into pageChunk parts past Chrome's 1 MB. Each direction passes only its own
// message types. It exits when either side closes, and writes nothing to stdout before the helper proved itself.
//
//   CARET_PAGE_SOCKET  the helper's page.sock (default ~/.caret-run/sockets/page.sock); the secret is beside it, <socket>.key
import AppKit
import CaretPageProtocol
import Darwin
import Foundation

let bridgeVersion = "0.1.0"
/// Time the helper has to challenge and then welcome. Assumed: both come from memory within milliseconds.
let handshakeSeconds: Int32 = 5

func log(_ s: String) {
    FileHandle.standardError.write(Data("[caret-bridge] \(s)\n".utf8))
}

func fail(_ s: String) -> Never {
    log(s)
    exit(1)
}

/// The browser that launched this host: its parent process.
func browserRef() -> BrowserRef {
    let ppid = getppid()
    let app = NSRunningApplication(processIdentifier: ppid)
    var name = app?.localizedName ?? ""
    if name.isEmpty {
        var buf = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        if proc_pidpath(ppid, &buf, UInt32(buf.count)) > 0 { name = (String(cString: buf) as NSString).lastPathComponent }
    }
    return BrowserRef(pid: ppid, bundleId: app?.bundleIdentifier ?? "unknown", name: name.isEmpty ? "unknown" : name)
}

/// Lines from the helper's socket, read with a deadline during the handshake and without one after.
final class LineSocket: @unchecked Sendable {
    let fd: Int32
    private var buffer = Data()
    init(fd: Int32) { self.fd = fd }

    /// The next line without its newline; nil at end of stream, on error, or when `timeout` (seconds) passes first.
    func next(timeout: Int32? = nil) -> Data? {
        while true {
            if let nl = buffer.firstIndex(of: 0x0A) {
                let line = Data(buffer[buffer.startIndex..<nl])
                buffer = Data(buffer[(nl + 1)...])
                return line
            }
            if let t = timeout {
                var p = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
                if poll(&p, 1, t * 1000) <= 0 { return nil }
            }
            var chunk = [UInt8](repeating: 0, count: 65536)
            let n = read(fd, &chunk, chunk.count)
            if n <= 0 { return nil }
            buffer.append(contentsOf: chunk[0..<n])
            if buffer.count > 64 * 1024 * 1024 { return nil }
        }
    }

    func write(line: Data) -> Bool {
        var d = line
        d.append(0x0A)
        return d.withUnsafeBytes { raw -> Bool in
            var off = 0
            while off < raw.count {
                let n = Darwin.write(fd, raw.baseAddress! + off, raw.count - off)
                if n < 0 { if errno == EINTR { continue }; return false }
                off += n
            }
            return true
        }
    }
}

/// Writes frames to Chrome; one writer at a time.
final class FrameOut: @unchecked Sendable {
    private let lock = NSLock()
    func send(_ payload: Data) {
        lock.lock(); defer { lock.unlock() }
        FileHandle.standardOutput.write(NativeFrame.encode(payload))
    }
}

func run() -> Never {
    let args = CommandLine.arguments
    guard args.count >= 2, let extensionId = Relay.extensionId(fromOrigin: args[1]) else {
        fail("expected the calling extension's origin, chrome-extension://<id>/, as the first argument")
    }
    signal(SIGPIPE, SIG_IGN)
    let socketPath = ProcessInfo.processInfo.environment["CARET_PAGE_SOCKET"]
        ?? (NSHomeDirectory() as NSString).appendingPathComponent(".caret-run/sockets/page.sock")

    let secret: Data
    let fd: Int32
    do {
        fd = try Peer.connect(path: socketPath)
        // Read after connecting: a helper that restarted in between wrote a new secret and challenges with it.
        secret = try SecretFile.read(path: SecretFile.path(forSocket: socketPath))
    } catch {
        fail("cannot reach the helper: \(error)")
    }
    let helper = LineSocket(fd: fd)
    let decoder = JSONDecoder()
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]

    guard let challengeLine = helper.next(timeout: handshakeSeconds),
          case let .engineChallenge(challenge)? = try? decoder.decode(PageMessage.self, from: challengeLine) else {
        fail("the helper sent no challenge")
    }
    let nonce = Handshake.nonce()
    let hello = EngineHello(browser: browserRef(), extensionId: extensionId, bridgeVersion: bridgeVersion, nonce: nonce,
                            proof: Handshake.bridgeProof(secret: secret, challenge: challenge.nonce, nonce: nonce))
    guard let helloLine = try? encoder.encode(hello), helper.write(line: helloLine) else { fail("cannot send the hello") }
    guard let welcomeLine = helper.next(timeout: handshakeSeconds),
          case let .engineWelcome(welcome)? = try? decoder.decode(PageMessage.self, from: welcomeLine) else {
        fail("the helper did not welcome this bridge")
    }
    guard Handshake.matches(Handshake.helperProof(secret: secret, challenge: challenge.nonce, nonce: nonce), welcome.proof) else {
        fail("the listener on \(socketPath) could not prove it holds the helper's secret; relaying nothing")
    }

    let out = FrameOut()
    guard let ready = try? encoder.encode(EngineReady(engine: welcome.engine)) else { fail("cannot encode engineReady") }
    out.send(ready)
    log("engine \(welcome.engine) ready for \(extensionId)")

    // Helper to extension.
    let fromHelper = Thread {
        var chunkSeq = 0
        while let line = helper.next() {
            switch Relay.admit(line, .toExtension) {
            case .failure(let why):
                log("dropped a helper line: \(why)")
            case .success:
                do {
                    for p in try Chunker.payloads(for: line, id: { chunkSeq += 1; return "k\(chunkSeq)" }()) { out.send(p) }
                } catch {
                    log("dropped a helper line that cannot be framed: \(error)")
                }
            }
        }
        log("the helper closed the connection")
        exit(0)
    }
    fromHelper.start()

    // Extension to helper, on this thread until Chrome closes stdin.
    var frames = FrameReader()
    let input = FileHandle.standardInput
    while true {
        let data = input.availableData
        if data.isEmpty { break }
        let payloads: [Data]
        do { payloads = try frames.feed(data) } catch { fail("corrupt frame from the extension: \(error)") }
        for p in payloads {
            switch Relay.admit(p, .toHelper) {
            case .failure(let why): log("dropped an extension message: \(why)")
            case .success: if !helper.write(line: p) { fail("the helper's socket closed") }
            }
        }
    }
    log("the extension closed the port")
    close(fd)
    exit(0)
}

run()
