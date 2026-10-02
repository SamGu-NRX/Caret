import AppKit
import CaretHost

// Launch by direct exec of Caret.app/Contents/MacOS/Caret so the process inherits the launching
// app's Accessibility grant. Flags: --socket <path>, --model <path>, --allow <bundle,ids>.
// Environment equivalents: CARET_HOST_SOCKET, CARET_MODEL_PATH, CARET_ALLOW_BUNDLES.

var configuration = HostRuntime.Configuration()
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
