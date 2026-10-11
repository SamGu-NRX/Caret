// caret-bridge: the Native Messaging host Chrome (or Chrome for Testing, or Helium) launches for Caret's extension.
// Chrome runs it with the calling extension's origin as its first argument and talks to it over stdin and stdout in
// Native Messaging frames. Since W3 it never touches page.sock or any key: it connects to the Caret host's XPC
// service, which holds it to the bridge's code-signing requirement while it holds the host to the host's
// (CaretBridgeXPC/Trust.swift), asks the host to open an engine for the extension, then relays: frames from the
// extension become lines to the host, lines from the host become frames, split into pageChunk parts past Chrome's
// 1 MB. Each direction passes only its own message types, here and again at the host. It exits when either side
// closes, and writes nothing to stdout before the host opened the engine.
//
//   CARET_BRIDGE_SERVICE  the host's Mach service (default BridgeTrust.machService); a test host's name in tests.
//                         The name grants nothing: whatever answers must satisfy the host requirement.
import CaretBridgeXPC
import CaretPageProtocol
import Darwin
import Foundation

let bridgeVersion = "0.2.0"
/// Time the host has to open the engine, its helper handshake included. Assumed: well under a second when the host runs.
let openSeconds: TimeInterval = 10

func log(_ s: String) {
    FileHandle.standardError.write(Data("[caret-bridge] \(s)\n".utf8))
}

func fail(_ s: String) -> Never {
    log(s)
    exit(1)
}

/// Writes frames to Chrome; one writer at a time. Lines from the host wait until the engine is open, so engineReady
/// is always the extension's first message.
final class FrameOut: @unchecked Sendable {
    private let lock = NSLock()
    private var open = false
    private var held: [Data] = []
    private var chunkSeq = 0

    func send(_ payload: Data) {
        lock.lock(); defer { lock.unlock() }
        write(payload)
    }

    /// Sends engineReady, then any host lines that came first.
    func ready(_ payload: Data) {
        lock.lock(); defer { lock.unlock() }
        write(payload)
        open = true
        for l in held { frame(l) }
        held = []
    }

    /// One helper line, chunked past Chrome's cap.
    func line(_ line: Data) {
        lock.lock(); defer { lock.unlock() }
        if open { frame(line) } else { held.append(line) }
    }

    private func frame(_ line: Data) {
        switch Relay.admit(line, .toExtension) {
        case let .failure(why): log("dropped a host line: \(why)")
        case .success:
            do {
                for p in try Chunker.payloads(for: line, id: { chunkSeq += 1; return "k\(chunkSeq)" }()) { write(p) }
            } catch {
                log("dropped a host line that cannot be framed: \(error)")
            }
        }
    }

    private func write(_ payload: Data) {
        // The throwing write: Chrome closing the pipe ends the bridge quietly instead of raising an exception.
        do { try FileHandle.standardOutput.write(contentsOf: NativeFrame.encode(payload)) } catch {
            log("the extension's port is gone")
            exit(0)
        }
    }
}

func run() -> Never {
    let args = CommandLine.arguments
    guard args.count >= 2, let extensionId = Relay.extensionId(fromOrigin: args[1]) else {
        fail("expected the calling extension's origin, chrome-extension://<id>/, as the first argument")
    }
    signal(SIGPIPE, SIG_IGN)
    let service = ProcessInfo.processInfo.environment["CARET_BRIDGE_SERVICE"] ?? BridgeTrust.machService
    let out = FrameOut()
    // The link calls onClose only once it was open; a close before that is open's failure, reported below with exit 1.
    let link = XPCHostLink(service: service, hostRequirement: BridgeTrust.hostRequirement,
                           onLine: { out.line($0) },
                           onClose: { why in
                               log(why)
                               exit(0)
                           })
    let engine: String
    switch link.open(extensionId: extensionId, bridgeVersion: bridgeVersion, timeout: openSeconds) {
    case let .failure(why): fail("relaying nothing: \(why)")
    case let .success(e): engine = e
    }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    guard let ready = try? encoder.encode(EngineReady(engine: engine)) else { fail("cannot encode engineReady") }
    out.ready(ready)
    log("engine \(engine) ready for \(extensionId) through \(service)")

    // Extension to host, on this thread until Chrome closes stdin.
    var frames = FrameReader()
    let input = FileHandle.standardInput
    while true {
        let data = input.availableData
        if data.isEmpty { break }
        let payloads: [Data]
        do { payloads = try frames.feed(data) } catch { fail("corrupt frame from the extension: \(error)") }
        for p in payloads {
            switch Relay.admit(p, .toHelper) {
            case let .failure(why): log("dropped an extension message: \(why)")
            case .success: link.send(p)
            }
        }
    }
    log("the extension closed the port")
    link.close()
    exit(0)
}

run()
