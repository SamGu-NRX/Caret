// caret-local-model --model PATH [--ctx N]
//
// Loads the GGUF at PATH once, by path (llama maps it; the file is never copied or moved), and writes one Ready
// line, or a NotReady line and exit 2. Then for each request line on stdin it writes one Completion or Failure
// line on stdout, in order. Exits 0 at end of input. llama's own warnings and errors go to stderr.
import Foundation
import LocalModelCore
import LocalModelLlama

/// A request line holds the few-shot prefix, the prompt and a grammar: tens of kilobytes. 4 MiB only bounds a bug.
let maxLineBytes = 4 << 20

func write(_ d: Data) {
    FileHandle.standardOutput.write(d)
}

func usage(_ why: String) -> Never {
    write(encodeLine(NotReady(error: "\(why); usage: caret-local-model --model PATH [--ctx N]")))
    exit(2)
}

var modelPath: String?
var contextLength = 4096
var args = CommandLine.arguments.dropFirst()
while let a = args.popFirst() {
    switch a {
    case "--model":
        guard let v = args.popFirst() else { usage("--model needs a path") }
        modelPath = v
    case "--ctx":
        guard let v = args.popFirst(), let n = Int(v), (512...32768).contains(n) else { usage("--ctx needs a number from 512 to 32768") }
        contextLength = n
    default:
        usage("unknown argument '\(a)'")
    }
}
guard let modelPath else { usage("--model is required") }

func handle(_ f: Frame, _ session: LlamaSession) {
    switch f {
    case .tooLong(let bytes):
        write(encodeLine(Failure(id: nil, error: "a line of \(bytes) bytes is longer than the \(maxLineBytes)-byte limit")))
    case .line(let d):
        switch parseRequest(d) {
        case .failure(let e):
            write(encodeLine(Failure(id: e.id, error: e.description)))
        case .success(let r):
            do {
                write(encodeLine(try session.complete(r)))
            } catch {
                write(encodeLine(Failure(id: r.id, error: String(describing: error))))
            }
        }
    }
}

/// Serves until end of input. The session is local so it is freed before `exit`: the Metal backend asserts at
/// process teardown when a context's buffers are still held.
func serve(modelPath: String, contextLength: Int) -> Int32 {
    let loadStart = ContinuousClock.now
    let session: LlamaSession
    do {
        session = try LlamaSession(modelPath: modelPath, contextLength: contextLength)
    } catch {
        write(encodeLine(NotReady(error: String(describing: error))))
        return 2
    }
    let load = (ContinuousClock.now - loadStart).components
    let loadMs = (Double(load.seconds) * 1000 + Double(load.attoseconds) / 1e15).rounded()
    write(encodeLine(Ready(model: URL(fileURLWithPath: modelPath).lastPathComponent, loadMs: loadMs, nCtx: session.nCtx, memory: MemoryUse.now())))
    var framer = LineFramer(maxBytes: maxLineBytes)
    while true {
        let chunk = FileHandle.standardInput.availableData
        if chunk.isEmpty { break }
        for f in framer.push(chunk) { handle(f, session) }
    }
    for f in framer.finish() { handle(f, session) }
    return 0
}

exit(serve(modelPath: modelPath, contextLength: contextLength))
