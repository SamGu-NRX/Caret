import AppKit
import CaretHost

// Launch by direct exec of Caret.app/Contents/MacOS/Caret so the process inherits the launching
// app's Accessibility grant. Flags: --socket <path>, --model <path>, --allow <bundle,ids>,
// --allow-pids <pid,pid>, --helper-socket <path>, --no-ghost, --no-fill-advance,
// --appearance light|dark, --perch hidden|shown, --surfaces headless|shown, --test-hooks,
// --settings <path>, --onboarding auto|show|hidden|off.
// Environment equivalents: CARET_HOST_SOCKET, CARET_MODEL_PATH, CARET_ALLOW_BUNDLES,
// CARET_ALLOW_PIDS, CARET_SCREEN_SOCKET, CARET_GHOST=off, CARET_FILL_ADVANCE=off, CARET_PERCH=hidden,
// CARET_SURFACES=headless, CARET_TEST_HOOKS=1, CARET_SETTINGS_PATH.

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
// `--appearance light|dark` (CARET_APPEARANCE) pins the overlays' appearance, for screenshots of
// both themes on one Mac without changing the system setting.
var appearanceName = ProcessInfo.processInfo.environment["CARET_APPEARANCE"]
var arguments = CommandLine.arguments.dropFirst().makeIterator()
while let argument = arguments.next() {
    switch argument {
    case "--socket": if let value = arguments.next() { configuration.socketPath = value }
    case "--model": if let value = arguments.next() { configuration.modelURL = URL(fileURLWithPath: value) }
    case "--allow-pids": configuration.allowedPIDs = HostRuntime.pids(arguments.next())
    case "--helper-socket": if let value = arguments.next() { configuration.helperSocketPath = value }
    case "--no-ghost": configuration.ghostEnabled = false
    case "--no-fill-advance": configuration.fillAdvances = false
    case "--appearance": appearanceName = arguments.next()
    case "--perch":
        // `hidden`: the perch and the activity list are computed and reported on the debug socket
        // but never drawn, for socket-only runs while someone is using the Mac.
        switch arguments.next() {
        case "hidden": configuration.perchDrawsOnScreen = false
        case "shown": configuration.perchDrawsOnScreen = true
        default: FileHandle.standardError.write(Data("caret: --perch takes hidden or shown\n".utf8)); exit(2)
        }
    case "--surfaces":
        // `headless`: helper offers are bound to the field the helper names and decided by the
        // arbiter, but nothing is drawn and the host writes nothing, for socket-level runs while
        // someone is using the Mac.
        switch arguments.next() {
        case "headless": configuration.surfacesHeadless = true
        case "shown": configuration.surfacesHeadless = false
        default: FileHandle.standardError.write(Data("caret: --surfaces takes headless or shown\n".utf8)); exit(2)
        }
    case "--test-hooks":
        // The debug socket's `inject` and `progress`, which fake helper offers and their results.
        configuration.testHooks = true
    case "--settings":
        // A settings file of the run's own, so a test never reads or writes the user's choices.
        if let value = arguments.next() { SettingsStore.path = value }
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
    switch appearanceName {
    case "dark": app.appearance = NSAppearance(named: .darkAqua)
    case "light": app.appearance = NSAppearance(named: .aqua)
    default: break
    }
    app.run()
}
