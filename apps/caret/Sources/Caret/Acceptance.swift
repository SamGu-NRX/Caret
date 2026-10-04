#if CARET_ACCEPTANCE_HOST
// The acceptance build only (scripts/build-app.sh acceptance, -DCARET_ACCEPTANCE_HOST). It is never shipped: it trusts
// Chrome for Testing, which is ad hoc signed, by the cdhash the run passes in, so the real host's relay can be tested
// with the browser the acceptance runs use (xpc-bridge-host spec, "How to verify on the host"). The shipped build has
// no way to add a browser at run time.
//
//   --acceptance-browser-requirement R   also accept a bridge whose parent satisfies R (repeatable)
//   --acceptance-services-only           start the helper, the reader and the bridge service, but no tap, overlay,
//                                        model or menu: launchd test runs on a shared Mac put nothing on screen
//   --acceptance-relay-socket P --acceptance-secret-file F
//                                        start nothing; relay bridges to the page.sock at P, keyed by the launch secret
//                                        in F (hex; read and deleted at start), the shape of caret-bridge-testhost, so
//                                        fixtures/web-form/accept.ts can drive its in-process helper through Caret.app
import CaretHost
import CaretHostCore
import Foundation

struct AcceptanceOptions {
    var browserRequirements: [String] = []
    var servicesOnly = false
    var relaySocket: String?
    var secretFile: String?

    mutating func take(_ argument: String, _ rest: inout IndexingIterator<ArraySlice<String>>) -> Bool {
        switch argument {
        case "--acceptance-browser-requirement":
            guard let r = rest.next() else { fail("--acceptance-browser-requirement needs a value") }
            browserRequirements.append(r)
        case "--acceptance-services-only": servicesOnly = true
        case "--acceptance-relay-socket": relaySocket = rest.next()
        case "--acceptance-secret-file": secretFile = rest.next()
        default: return false
        }
        return true
    }

    /// Runs one of the acceptance modes and never returns, or returns at once when none was asked for.
    func runIfAsked(home: CaretHome) {
        log("ACCEPTANCE BUILD: trusts \(browserRequirements.count) extra browser requirement(s); never ship this build")
        if relaySocket != nil || secretFile != nil {
            guard let socket = relaySocket, let file = secretFile else { fail("--acceptance-relay-socket and --acceptance-secret-file go together") }
            guard let hex = try? String(contentsOfFile: file, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
                  let secret = Data(hexString: hex), secret.count == 32 else { fail("\(file) does not hold a 32-byte hex launch secret") }
            unlink(file)
            let summary = MainActor.assumeIsolated {
                CaretServices.acceptanceRelay(pageSocket: socket, launchSecret: secret, browserRequirements: browserRequirements,
                                              environment: ProcessInfo.processInfo.environment)
            }
            log("relay to \(socket): page bridge \(summary)")
            runForever(stop: {})
        }
        guard servicesOnly else { return }
        let plan = MainActor.assumeIsolated {
            CaretServices.plan(home: home, namedHelperSocket: nil, legacyHelperSocket: home.screenSocket,
                               bundle: Bundle.main.bundleURL, environment: ProcessInfo.processInfo.environment)
        }
        guard case .run(let mode) = plan else { fail("the acceptance build never hands off to an agent") }
        let services: CaretServices
        do {
            services = try MainActor.assumeIsolated { try CaretServices(mode: mode, extraBrowserRequirements: browserRequirements) }
        } catch {
            fail("\(error)")
        }
        MainActor.assumeIsolated { services.start() }
        runForever(stop: { await services.stop() })
    }

    private func runForever(stop: @escaping @MainActor () async -> Void) -> Never {
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler {
                MainActor.assumeIsolated {
                    Task {
                        await stop()
                        exit(0)
                    }
                }
            }
            source.resume()
            AcceptanceOptions.keep.append(source)
        }
        RunLoop.main.run()
        exit(0)
    }

    nonisolated(unsafe) static var keep: [DispatchSourceSignal] = []

    private func log(_ s: String) {
        FileHandle.standardError.write(Data("[caret-host acceptance] \(s)\n".utf8))
    }

    private func fail(_ s: String) -> Never {
        log(s)
        exit(2)
    }
}

private extension Data {
    init?(hexString: String) {
        guard hexString.count % 2 == 0 else { return nil }
        var out = Data(capacity: hexString.count / 2)
        var i = hexString.startIndex
        while i < hexString.endIndex {
            let j = hexString.index(i, offsetBy: 2)
            guard let b = UInt8(hexString[i..<j], radix: 16) else { return nil }
            out.append(b)
            i = j
        }
        self = out
    }
}
#endif
