import AppKit
import CaretHost

// Launch by direct exec of Caret.app/Contents/MacOS/Caret so the process inherits the launching
// app's Accessibility grant. Flags: --socket <path>, --model <path>, --allow <bundle,ids>.
// Environment equivalents: CARET_HOST_SOCKET, CARET_MODEL_PATH, CARET_ALLOW_BUNDLES.

var configuration = HostRuntime.Configuration()

// Dev mode: `Caret --probe-typing <text>` times one generation per typed prefix.
if CommandLine.arguments.dropFirst().first == "--probe-typing", CommandLine.arguments.count >= 3 {
    let text = CommandLine.arguments[2]
    let modelURL = configuration.modelURL
    MainActor.assumeIsolated {
        Task {
            print(await DevProbe.typing(modelURL: modelURL, text: text), terminator: "")
            exit(0)
        }
    }
    RunLoop.main.run()
}

// Dev mode: `Caret --probe [--bos on|off] <text>...` prints the engine's offer for each text.
if CommandLine.arguments.dropFirst().first == "--probe" {
    var rest = Array(CommandLine.arguments.dropFirst(2))
    var bos: Bool?
    if rest.first == "--bos", rest.count >= 2 {
        bos = rest[1] == "on"
        rest.removeFirst(2)
    }
    let texts = rest
    let modelURL = configuration.modelURL
    MainActor.assumeIsolated {
        Task {
            print(await DevProbe.run(modelURL: modelURL, texts: texts, prependBOS: bos), terminator: "")
            exit(0)
        }
    }
    RunLoop.main.run()
}
var arguments = CommandLine.arguments.dropFirst().makeIterator()
while let argument = arguments.next() {
    switch argument {
    case "--socket": if let value = arguments.next() { configuration.socketPath = value }
    case "--model": if let value = arguments.next() { configuration.modelURL = URL(fileURLWithPath: value) }
    case "--allow":
        if let value = arguments.next() {
            configuration.allowedBundleIDs = Set(value.split(separator: ",").map(String.init))
        }
    default: FileHandle.standardError.write(Data("caret: ignoring argument \(argument)\n".utf8))
    }
}

let launchConfiguration = configuration
MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate(configuration: launchConfiguration)
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
}
