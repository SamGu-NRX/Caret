import AppKit
import CaretHost
import CaretHostCore

// Launch by direct exec of Caret.app/Contents/MacOS/Caret so the process inherits the launching
// app's Accessibility grant. Flags: --socket <path>, --model <path>, --allow <bundle,ids>,
// --allow-pids <pid,pid>, --helper-socket <path>, --no-ghost, --no-fill-advance,
// --appearance light|dark, --perch hidden|shown, --surfaces headless|shown, --test-hooks, --ghost-replay <file>,
// --settings <path>, --onboarding auto|show|hidden|off, --status-item off, --ghost-overflow capsule|drop,
// --home <dir>, --nmh-dir <dir>.
// Environment equivalents: CARET_HOST_SOCKET, CARET_MODEL_PATH, CARET_ALLOW_BUNDLES,
// CARET_ALLOW_PIDS, CARET_SCREEN_SOCKET, CARET_GHOST=off, CARET_FILL_ADVANCE=off, CARET_PERCH=hidden,
// CARET_SURFACES=headless, CARET_TEST_HOOKS=1, CARET_SETTINGS_PATH,
// CARET_ONBOARDING, CARET_STATUS_ITEM=off, CARET_GHOST_OVERFLOW=drop, CARET_HOME, CARET_NMH_DIR.
//
// A built Caret.app starts its own helper and caret-screen (H4, CaretServices) unless a helper socket is named
// (--helper-socket, CARET_SCREEN_SOCKET), which every acceptance script does. --home <dir> puts their sockets and data,
// and the host's debug socket and settings unless named, in <dir> instead of ~/Library/Application Support/CaretV2.
// --nmh-dir <dir> is where Add to Chrome writes its manifest in such a run; a run with --home writes nowhere else.

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

// Dev mode: `Caret --probe-replay <cases.json> <out.json>` records the engine's outcome for each
// case as a `--ghost-replay` file, and prints every candidate's refusal and fit scores.
if CommandLine.arguments.dropFirst().first == "--probe-replay", CommandLine.arguments.count >= 4 {
    let cases = URL(fileURLWithPath: CommandLine.arguments[2])
    let out = URL(fileURLWithPath: CommandLine.arguments[3])
    let modelURL = configuration.modelURL
    MainActor.assumeIsolated {
        Task {
            print(await DevProbe.replay(modelURL: modelURL, cases: cases, out: out), terminator: "")
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
var showsStatusItem = ProcessInfo.processInfo.environment["CARET_STATUS_ITEM"] != "off"
let environment = ProcessInfo.processInfo.environment
if let raw = environment["CARET_ALLOW_PIDS"], !raw.isEmpty {
    do {
        configuration.allowedPIDs = try HostRuntime.allowedPIDs(raw)
    } catch {
        FileHandle.standardError.write(Data("caret: CARET_ALLOW_PIDS \(error)\n".utf8))
        exit(2)
    }
}
var homeOverride = environment["CARET_HOME"]
var manifestDirectory = environment["CARET_NMH_DIR"]
if manifestDirectory?.isEmpty == true {
    FileHandle.standardError.write(Data("caret: CARET_NMH_DIR is set but empty\n".utf8))
    exit(2)
}
var namedHelperSocket = environment["CARET_SCREEN_SOCKET"].flatMap { $0.isEmpty ? nil : $0 }
var hostSocketNamed = environment["CARET_HOST_SOCKET"].map { !$0.isEmpty } ?? false
var settingsNamed = environment["CARET_SETTINGS_PATH"].map { !$0.isEmpty } ?? false
#if CARET_ACCEPTANCE_HOST
var acceptance = AcceptanceOptions()
#endif
var arguments = CommandLine.arguments.dropFirst().makeIterator()
while let argument = arguments.next() {
    switch argument {
    case "--socket":
        if let value = arguments.next() {
            configuration.socketPath = value
            hostSocketNamed = true
        }
    case "--model": if let value = arguments.next() { configuration.modelURL = URL(fileURLWithPath: value) }
    case "--allow-pids":
        // A missing or mistyped list would lift the restriction it was meant to set; refuse it instead.
        do {
            configuration.allowedPIDs = try HostRuntime.allowedPIDs(arguments.next())
        } catch {
            FileHandle.standardError.write(Data("caret: --allow-pids \(error)\n".utf8))
            exit(2)
        }
    case "--helper-socket":
        if let value = arguments.next() {
            configuration.helperSocketPath = value
            namedHelperSocket = value
        }
    case "--home", "--nmh-dir":
        // A missing or empty value would fall back to the user's real home or browser (H4 review); refuse it.
        guard let value = arguments.next(), !value.isEmpty, !value.hasPrefix("--") else {
            FileHandle.standardError.write(Data("caret: \(argument) needs a directory\n".utf8))
            exit(2)
        }
        if argument == "--home" { homeOverride = value } else { manifestDirectory = value }
    case "--no-ghost": configuration.ghostEnabled = false
    case "--ghost-replay": configuration.ghostReplayPath = arguments.next()
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
    case "--ghost-overflow":
        // `drop` keeps KeyType's rule (a completion too wide for its line is not drawn), to
        // measure the before row of A10's placement table on the same build.
        switch arguments.next() {
        case "capsule": configuration.ghostOverflow = .capsule
        case "drop": configuration.ghostOverflow = .drop
        default: FileHandle.standardError.write(Data("caret: --ghost-overflow takes capsule or drop\n".utf8)); exit(2)
        }
    case "--test-hooks":
        // The debug socket's `inject` and `progress`, which fake helper offers and their results.
        configuration.testHooks = true
    case "--status-item":
        // `off`: no menu bar item, for socket-only runs that must put nothing on screen.
        switch arguments.next() {
        case "off": showsStatusItem = false
        case "on": showsStatusItem = true
        default: FileHandle.standardError.write(Data("caret: --status-item takes on or off\n".utf8)); exit(2)
        }
    case "--onboarding":
        // `off` (default: the menu's Set Up Caret opens it), `auto` (at launch until finished
        // once), `show`, or `hidden` (the flow with no window, driven over the debug socket).
        switch arguments.next() {
        case let mode? where ["off", "auto", "show", "hidden"].contains(mode): configuration.onboarding = mode
        default: FileHandle.standardError.write(Data("caret: --onboarding takes off, auto, show or hidden\n".utf8)); exit(2)
        }
    case "--settings":
        // A settings file of the run's own, so a test never reads or writes the user's choices.
        if let value = arguments.next() {
            SettingsStore.path = value
            settingsNamed = true
        }
    case "--allow":
        if let value = arguments.next() {
            configuration.allowedBundleIDs = Set(value.split(separator: ",").map(String.init))
        }
    default:
        #if CARET_ACCEPTANCE_HOST
        if acceptance.take(argument, &arguments) { continue }
        #endif
        FileHandle.standardError.write(Data("caret: ignoring argument \(argument)\n".utf8))
    }
}

let home: CaretHome
do {
    home = try CaretHome.resolve(override: homeOverride, userHome: NSHomeDirectory())
} catch {
    FileHandle.standardError.write(Data("caret: \(error)\n".utf8))
    exit(2)
}
if home.isOverride {
    // A run with its own home reads and writes only there.
    if !hostSocketNamed { configuration.socketPath = home.hostSocket }
    if !settingsNamed { SettingsStore.path = home.settingsFile }
}

#if CARET_ACCEPTANCE_HOST
acceptance.runIfAsked(home: home)
#endif

let services: CaretServices
switch CaretServices.plan(home: home, namedHelperSocket: namedHelperSocket, legacyHelperSocket: configuration.helperSocketPath,
                          bundle: Bundle.main.bundleURL, environment: environment) {
case .exit(let why):
    FileHandle.standardError.write(Data("caret: \(why); this copy exits\n".utf8))
    exit(0)
case .run(let mode):
    // The acceptance build trusts the browsers its run named in full-UI mode too, so a VM run can drive the
    // extension against a whole Caret (H8 decision 2). The shipped build has no such flag and passes none.
    #if CARET_ACCEPTANCE_HOST
    let extraBrowsers = acceptance.browserRequirements
    #else
    let extraBrowsers: [String] = []
    #endif
    do {
        services = try MainActor.assumeIsolated { try CaretServices(mode: mode, extraBrowserRequirements: extraBrowsers) }
    } catch {
        FileHandle.standardError.write(Data("caret: \(error)\n".utf8))
        exit(1)
    }
}
configuration.helperSocketPath = MainActor.assumeIsolated { services.helperSocket }

let launchConfiguration = configuration
let launchStatusItem = showsStatusItem
let launchManifestDirectory = manifestDirectory
MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate(configuration: launchConfiguration, services: services, home: home,
                               manifestDirectory: launchManifestDirectory, showsStatusItem: launchStatusItem)
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    switch appearanceName {
    case "dark": app.appearance = NSAppearance(named: .darkAqua)
    case "light": app.appearance = NSAppearance(named: .aqua)
    default: break
    }
    app.run()
}
