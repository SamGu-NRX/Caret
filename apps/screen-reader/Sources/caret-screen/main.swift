// caret-screen: Caret's Accessibility reader.
//
//   caret-screen [--shadow] [--socket PATH] [--deny-list PATH] [--background-interval S]
//                [--event-pids P,P] [--event-bundles B,B] [--only-pids P,P] [--record FILE] [--e1-log FILE]
//   caret-screen --e8 --pids P,P [--title-match REGEX] [--runs N] [--interval S] --out FILE
//
// Default mode streams NDJSON to the helper's socket. --shadow tells the helper to log
// opportunities and show nothing. Launch by direct exec so the process inherits Accessibility.
import AppKit
import ApplicationServices
import CaretScreenAX
import CaretScreenCore
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)
let version = "caret-screen 0.1.0"

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write(Data("caret-screen: \(msg)\n".utf8))
    exit(2)
}

var args = Array(CommandLine.arguments.dropFirst())
@MainActor func flag(_ name: String) -> Bool {
    guard let i = args.firstIndex(of: name) else { return false }
    args.remove(at: i)
    return true
}
@MainActor func option(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name) else { return nil }
    guard i + 1 < args.count else { fail("\(name) needs a value") }
    let v = args[i + 1]
    args.removeSubrange(i...(i + 1))
    return v
}
func pids(_ s: String?) -> Set<pid_t> {
    guard let s else { return [] }
    return Set(s.split(separator: ",").map { p in
        guard let v = pid_t(p.trimmingCharacters(in: .whitespaces)) else { fail("not a pid: \(p)") }
        return v
    })
}

let home = FileManager.default.homeDirectoryForCurrentUser.path
let shadow = flag("--shadow")
let e8 = flag("--e8")
let socketPath = option("--socket") ?? "\(home)/.caret-run/sockets/screen.sock"
let denyPath = option("--deny-list") ?? "\(home)/.caret-run/deny-apps.txt"
let background = option("--background-interval").map { TimeInterval($0) ?? 30 } ?? 30
let eventPids = pids(option("--event-pids"))
let onlyPids = pids(option("--only-pids"))
let eventBundles = Set((option("--event-bundles") ?? "").split(separator: ",").map(String.init))
let recordPath = option("--record")
let e1Path = option("--e1-log")
let e8Pids = pids(option("--pids"))
let titleMatch = option("--title-match")
let runs = Int(option("--runs") ?? "100") ?? 100
let interval = TimeInterval(option("--interval") ?? "0.25") ?? 0.25
let outPath = option("--out")
if !args.isEmpty { fail("unknown arguments: \(args.joined(separator: " "))") }
// A recording holds screen text, so it is only allowed for processes named explicitly (fixtures).
if recordPath != nil && onlyPids.isEmpty { fail("--record writes screen text to disk; it needs --only-pids naming fixture processes") }

guard AXIsProcessTrusted() else {
    fail("not trusted for Accessibility. Launch the binary directly from a process that has the grant.")
}

let deny: DenyList
do { deny = try DenyList.load(path: denyPath) } catch { fail("cannot read deny list \(denyPath): \(error)") }

func openForWriting(_ path: String) -> FileHandle {
    FileManager.default.createFile(atPath: path, contents: nil)
    guard let h = FileHandle(forWritingAtPath: path) else { fail("cannot write \(path)") }
    return h
}

if e8 {
    guard let out = outPath, !e8Pids.isEmpty else { fail("--e8 needs --pids and --out") }
    let re = titleMatch.map { try! NSRegularExpression(pattern: $0) }
    let ctx = ReaderContext(emitter: FileEmitter(handle: FileHandle.nullDevice))
    var workers: [AppWorker] = []
    for pid in e8Pids {
        guard let app = NSRunningApplication(processIdentifier: pid) else { fail("no process \(pid)") }
        if deny.denies(app.bundleIdentifier ?? "") { fail("\(pid) is on the deny list") }
        workers.append(AppWorker(pid: pid, app: AppRef(pid: Int(pid), bundleId: app.bundleIdentifier ?? "", name: app.localizedName ?? ""), ctx: ctx))
    }
    let reports = MainActor.assumeIsolated { KeyStability.run(workers: workers, titleMatch: re, runs: runs, interval: interval) }
    let enc = JSONEncoder()
    enc.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    try! enc.encode(reports).write(to: URL(fileURLWithPath: out))
    for r in reports {
        print("\(r.app) | \(r.window) | runs \(r.runs) | nodes \(Int(r.meanNodes)) | walk \(Int(r.meanWalkMs)) ms | stable \(r.stableKey)/\(r.presentInAll) present-in-all of \(r.tracked) | keys in all \(r.keysInAll)/\(r.keysFirst)")
    }
    exit(0)
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

let socket = SocketEmitter(path: socketPath, hello: Hello(role: .reader, mode: shadow ? .shadow : .live, pid: Int(getpid()), version: version))
var emitter: Emitter = socket
if let p = recordPath { emitter = TeeEmitter([socket, FileEmitter(handle: openForWriting(p))]) }
let ctx = ReaderContext(emitter: emitter)
var recorder: NotificationRecorder?
if let p = e1Path {
    let r = NotificationRecorder(handle: openForWriting(p))
    recorder = r
    ctx.notificationTap = { t, pid, name, el in r.tap(t, pid, name, el) }
}

var options = ReaderOptions(denyList: deny)
options.backgroundInterval = background
options.eventPids = eventPids
options.onlyPids = onlyPids
options.eventBundles = eventBundles
let reader = MainActor.assumeIsolated { ScreenReader(ctx: ctx, options: options) }
var connectedOnce = false
socket.onConnect = {
    DispatchQueue.main.async {
        MainActor.assumeIsolated {
            if connectedOnce { reader.resync() }
            connectedOnce = true
        }
    }
}
socket.start()
MainActor.assumeIsolated { reader.start() }

for sig in [SIGINT, SIGTERM] {
    signal(sig, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler {
        ctx.log("stopping; sent \(socket.sent) messages, dropped \(socket.dropped), e1 lines \(recorder?.count ?? 0)")
        exit(0)
    }
    src.resume()
    _ = Unmanaged.passRetained(src)
}
app.run()
