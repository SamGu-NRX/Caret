// caret-bridge-testhost: a stand-in for Caret.app's side of the bridge, for the acceptance run (W3). It is not shipped.
// launchd starts it from a temporary job that names `--service` under MachServices; it checks in for that name, holds
// every bridge to the bridge requirement and its parent to a browser requirement, and relays to the helper's
// page.sock with the page key of the launch secret it is handed (CaretBridgeXPC/HostRelay.swift).
//
//   caret-bridge-testhost --service NAME --socket PATH --secret-file PATH [--bridge-requirement R] [--browser-requirement R]...
//
// --secret-file holds the 32-byte launch secret as hex in a file only the user can read; it is read and deleted at
// start. That file exists only in this harness, where the helper runs inside the acceptance process: Caret.app makes
// the launch secret itself, hands it to the helper on an inherited descriptor, and never writes it anywhere.
// --browser-requirement replaces BridgeTrust.browserRequirements (the run names Chrome for Testing by its cdhash).
import CaretBridgeXPC
import CaretPageProtocol
import Darwin
import Foundation

func log(_ s: String) {
    let t = ISO8601DateFormatter().string(from: Date())
    FileHandle.standardError.write(Data("[caret-bridge-testhost \(t)] \(s)\n".utf8))
}

func fail(_ s: String) -> Never {
    log(s)
    exit(1)
}

var service: String?
var socket: String?
var secretFile: String?
var bridgeRequirement = BridgeTrust.bridgeRequirement
var browserRequirements: [String] = []
var it = CommandLine.arguments.dropFirst().makeIterator()
while let a = it.next() {
    guard let v = it.next() else { fail("\(a) needs a value") }
    switch a {
    case "--service": service = v
    case "--socket": socket = v
    case "--secret-file": secretFile = v
    case "--bridge-requirement": bridgeRequirement = v
    case "--browser-requirement": browserRequirements.append(v)
    default: fail("unknown argument \(a)")
    }
}
guard let service, let socket, let secretFile else { fail("usage: --service NAME --socket PATH --secret-file PATH [--bridge-requirement R] [--browser-requirement R]...") }
if browserRequirements.isEmpty { browserRequirements = BridgeTrust.browserRequirements }
for r in [bridgeRequirement] + browserRequirements where !ProcessTrust.parses(r) { fail("not a code requirement: \(r)") }

guard let hex = try? String(contentsOfFile: secretFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
      let secret = Data(hex: hex), secret.count == 32 else { fail("\(secretFile) does not hold a 32-byte hex launch secret") }
unlink(secretFile)

let browsers = browserRequirements
let config = HostRelayConfig(socketPath: socket, pageKey: Handshake.pageKey(launchSecret: secret), bridgeRequirement: bridgeRequirement,
                             launchingBrowser: { ProcessTrust.launchingBrowser(of: $0, requirements: browsers) })
let listener = BridgeListener(listener: NSXPCListener(machServiceName: service), config: config, log: log)
listener.resume()
log("listening on \(service) for page.sock \(socket); bridge requirement: \(bridgeRequirement); \(browsers.count) browser requirement(s)")
dispatchMain()
