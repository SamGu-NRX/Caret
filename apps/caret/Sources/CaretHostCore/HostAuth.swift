import CaretScreenCore
import CryptoKit
import Darwin
import Foundation

/// The host's proof to the helper that it is the Caret holding the launch secret (helper/src/host-auth.ts). Any process
/// of the user can connect to the helper's socket; only a connection whose proof checks out is sent what Caret's
/// Accessibility grant reads (page text, saved answers, route decisions, goal previews).
///
/// The helper answers a hello with `host: true` with `hostChallenge`; the host answers with `hostProof`, an HMAC of the
/// challenge under the host key; the helper says `hostAuthenticated` and only then treats the connection as the host.
/// The host key is HMAC-SHA256(launch secret, "caret-host-key"), apart from the reader's proof and page.sock's key, so
/// no proof made under one passes another check. Golden vector: helper/fixtures/golden/host-auth.json.
public enum HostAuth {
    /// The host key for one launch, derived as the helper derives it (host-auth.ts hostKey).
    public static func hostKey(launchSecret: Data) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: Data("caret-host-key".utf8), using: SymmetricKey(data: launchSecret)))
    }

    /// The answer to the helper's `nonce`: base64 HMAC-SHA256(hostKey, "caret-host-proof\n" + nonce).
    public static func proof(hostKey: Data, nonce: String) -> String {
        Data(HMAC<SHA256>.authenticationCode(for: Data("caret-host-proof\n\(nonce)".utf8), using: SymmetricKey(data: hostKey))).base64EncodedString()
    }

    /// The environment variable naming an inherited descriptor that holds the host key, for a Caret attached to a helper
    /// a script started (helper/src/launch.ts --host-key-fd). It holds only the descriptor's number.
    public static let keyDescriptorVariable = "CARET_HOST_KEY_FD"

    public struct KeyError: Error, CustomStringConvertible, Equatable {
        public let description: String
        init(_ d: String) { description = d }
    }

    /// The 32-byte host key read from the descriptor `CARET_HOST_KEY_FD` names, which is then closed; nil when the
    /// variable is unset or empty. Reads exactly 32 bytes, so a writer that keeps its end open cannot hold the launch.
    /// Throws, by name, for a value that is not a descriptor of 3 or above, a descriptor that is not open, or one that
    /// ends before 32 bytes; any descriptor it could open is closed either way.
    public static func readInheritedKey(environment: [String: String]) throws -> Data? {
        guard let raw = environment[keyDescriptorVariable], !raw.isEmpty else { return nil }
        guard raw.allSatisfy(\.isASCII), raw.allSatisfy(\.isNumber), let fd = Int32(raw), fd >= 3 else {
            throw KeyError("\(keyDescriptorVariable) is \"\(raw)\", not an inherited descriptor (3 and above)")
        }
        guard fcntl(fd, F_GETFD) != -1 else {
            throw KeyError("\(keyDescriptorVariable) names descriptor \(fd), which is not open")
        }
        defer { close(fd) }
        var key = [UInt8](repeating: 0, count: 32)
        var got = 0
        while got < key.count {
            let n = key.withUnsafeMutableBytes { read(fd, $0.baseAddress! + got, $0.count - got) }
            if n < 0, errno == EINTR { continue }
            if n < 0 { throw KeyError("\(keyDescriptorVariable) descriptor \(fd): \(String(cString: strerror(errno)))") }
            if n == 0 { break }
            got += n
        }
        guard got == key.count else {
            throw KeyError("\(keyDescriptorVariable) descriptor \(fd) ended after \(got) bytes; a host key is 32")
        }
        return Data(key)
    }
}

/// Helper to host (protocol.ts HostChallenge): the challenge for this connection, base64 of 32 random bytes.
public struct HostChallenge: Decodable, Equatable, Sendable {
    public static let type = "hostChallenge"
    public var nonce: String

    public init(nonce: String) { self.nonce = nonce }

    enum CodingKeys: String, CodingKey { case type, v, nonce }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard try c.decode(String.self, forKey: .type) == Self.type else { throw ProtocolError("expected \(Self.type)") }
        guard try c.decode(Int.self, forKey: .v) == Proto.version else { throw ProtocolError("unsupported protocol version for \(Self.type)") }
        nonce = try c.decode(String.self, forKey: .nonce)
        guard nonce.count >= 16 else { throw ProtocolError("a hostChallenge nonce is at least 16 characters") }
    }
}

/// Host to helper (protocol.ts HostProof): the answer to `HostChallenge`, the host's next line after its hello.
public struct HostProof: Codable, Equatable, Sendable {
    public static let type = "hostProof"
    public var proof: String

    public init(proof: String) { self.proof = proof }

    enum CodingKeys: String, CodingKey { case type, v, proof }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard try c.decode(String.self, forKey: .type) == Self.type else { throw ProtocolError("expected \(Self.type)") }
        guard try c.decode(Int.self, forKey: .v) == Proto.version else { throw ProtocolError("unsupported protocol version for \(Self.type)") }
        proof = try c.decode(String.self, forKey: .proof)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.type, forKey: .type)
        try c.encode(Proto.version, forKey: .v)
        try c.encode(proof, forKey: .proof)
    }
}

/// Why the helper did not take this Caret as its host on one connection: what to log, and what the menu says.
public struct HostRefusal: Equatable, Sendable, CustomStringConvertible {
    public enum Reason: Equatable, Sendable {
        /// The helper answered the proof with an error: the key is not the one its launch secret gives.
        case keyRefused
        /// The helper answered the hello with an error before any challenge, as one with no launch secret does.
        case helloRefused
        /// The connection closed before the helper accepted this host, with no error first.
        case closed
        /// The helper sent something other than a challenge first: it does not authenticate hosts.
        case notChallenged
        /// The helper sent a handshake message out of turn, or something else where its acceptance belonged.
        case outOfTurn
        /// Caret could not encode its proof or write it.
        case proofNotSent
    }

    public var reason: Reason
    /// What happened, with the helper's own words when it sent any. For the log and the debug socket.
    public var detail: String

    public init(_ reason: Reason, _ detail: String) {
        self.reason = reason
        self.detail = detail
    }

    public var description: String { detail }

    /// The reason in plain words, for the menu's status line (`HostRetry.statusLine`).
    public var plainReason: String {
        switch reason {
        case .keyRefused: return "the helper refused Caret's key"
        case .helloRefused: return "the helper refused to take Caret as its host"
        case .closed: return "the helper closed the connection before accepting Caret's key"
        case .notChallenged: return "the helper doesn't check Caret's key, so it may be out of date"
        case .outOfTurn: return "the helper answered Caret's key out of turn"
        case .proofNotSent: return "Caret couldn't send its key to the helper"
        }
    }
}

/// The host's side of the handshake on one connection. HelperClient feeds it every message until it is done; it says
/// what to write, when the connection becomes the host's, and why to close it.
public struct HostHandshake: Sendable {
    public enum Step: Equatable, Sendable {
        /// Write this line (the proof) and wait for the helper's answer.
        case send(Data)
        /// The helper accepted the proof: the connection now carries this host's messages.
        case authenticated
        /// Not part of the handshake: hand it to the host as usual.
        case deliver
        /// Close the connection, for this reason.
        case fail(HostRefusal)
        /// The handshake already failed and the connection is closing: drop the message.
        case discard
    }

    private enum State: Sendable { case awaitingChallenge, awaitingAcceptance, done, failed(HostRefusal) }

    private let hostKey: Data?
    private var state: State

    /// With no host key the hello says nothing of a host, and there is no handshake.
    public init(hostKey: Data?) {
        self.hostKey = hostKey
        state = hostKey == nil ? .done : .awaitingChallenge
    }

    /// The connection carries this host's messages: at once without a host key, after `hostAuthenticated` with one.
    public var isDone: Bool { if case .done = state { return true } else { return false } }

    /// Why this connection did not become the host's, once it has closed: the refusal it failed with, or `closed` when it
    /// ended before the helper accepted. Nil after `hostAuthenticated`, and for a Caret with no key unless the helper
    /// challenged it.
    public var refusal: HostRefusal? {
        switch state {
        case .done: return nil
        case .failed(let r): return r
        case .awaitingChallenge, .awaitingAcceptance:
            return HostRefusal(.closed, "the helper closed the connection before it accepted this host")
        }
    }

    public mutating func receive(_ message: HelperInbound) -> Step {
        let step = next(message)
        if case .fail(let r) = step { state = .failed(r) }
        return step
    }

    private mutating func next(_ message: HelperInbound) -> Step {
        switch (state, message) {
        case (.failed, _):
            return .discard
        case (.awaitingChallenge, .hostChallenge(let challenge)):
            guard let hostKey, let line = try? NDJSON.line(HostProof(proof: HostAuth.proof(hostKey: hostKey, nonce: challenge.nonce))) else {
                return .fail(HostRefusal(.proofNotSent, "the host could not encode its proof"))
            }
            state = .awaitingAcceptance
            return .send(line)
        case (.awaitingAcceptance, .hostAuthenticated):
            state = .done
            return .authenticated
        case (.awaitingChallenge, .error(let e)):
            return .fail(HostRefusal(.helloRefused, "the helper refused this host: \(e.message)"))
        case (.awaitingAcceptance, .error(let e)):
            return .fail(HostRefusal(.keyRefused, "the helper refused this host: \(e.message)"))
        case (.awaitingChallenge, _):
            return .fail(HostRefusal(.notChallenged, "the helper sent \(message.typeName) before its hostChallenge; it does not authenticate hosts"))
        case (.awaitingAcceptance, _):
            return .fail(HostRefusal(.outOfTurn, "the helper sent \(message.typeName) instead of hostAuthenticated"))
        case (.done, .hostChallenge), (.done, .hostAuthenticated):
            return .fail(HostRefusal(.outOfTurn, "the helper sent \(message.typeName) to a connection that is not waiting for one"))
        case (.done, _):
            return .deliver
        }
    }
}

/// When the host tries the helper again after the helper did not take it as its host, and what the menu says meanwhile.
///
/// A helper that refuses the host's proof, or closes the connection during the handshake, most likely refuses the next
/// attempt the same way (a key from another launch, a helper started without a launch secret, an older helper), so
/// attempts back off: 2 s, doubling, at most 60 s. The first `hostAuthenticated` starts the schedule over and clears the
/// status line. A connection that drops after the helper accepted this host is not a refusal: HelperClient retries it on
/// its own short backoff.
public struct HostRetry: Equatable, Sendable {
    public static let firstDelay: TimeInterval = 2
    public static let maxDelay: TimeInterval = 60

    /// The last refusal, until the helper accepts this host.
    public private(set) var refusal: HostRefusal?
    private var nextDelay = HostRetry.firstDelay

    public init() {}

    /// Records a refusal and returns how long to wait before the next connection.
    public mutating func refused(_ r: HostRefusal) -> TimeInterval {
        refusal = r
        defer { nextDelay = min(Self.maxDelay, nextDelay * 2) }
        return nextDelay
    }

    /// The helper accepted this host: the next refusal waits `firstDelay` again, and the status line clears.
    public mutating func authenticated() {
        refusal = nil
        nextDelay = Self.firstDelay
    }

    /// The menu's status line while the helper refuses this host; nil once it accepts.
    public var statusLine: String? { refusal.map { "Caret can't reach its helper: \($0.plainReason)" } }
}
