import CaretHostCore
import Foundation

/// The user's settings (`CaretSettings`), kept as JSON in one file. The main thread owns it.
///
/// Path: `--settings`, else `CARET_SETTINGS_PATH`, else
/// `~/Library/Application Support/Caret/v2-host/settings.json`. Test runs name a temporary file so
/// they never touch the user's own choices.
@MainActor
public final class SettingsStore {
    public static let shared = SettingsStore()

    /// Where the next `shared` reads from. Set by the app shell before anything reads settings.
    public nonisolated(unsafe) static var path: String = {
        if let override = ProcessInfo.processInfo.environment["CARET_SETTINGS_PATH"], !override.isEmpty { return override }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Caret/v2-host/settings.json").path
    }()

    public let path: String
    public private(set) var settings: CaretSettings
    /// Why the file could not be read, when it exists but is not settings this host understands.
    /// The defaults are used meanwhile, and the file is not overwritten until the user changes a
    /// setting.
    public private(set) var loadError: String?
    private var observers: [UUID: (CaretSettings) -> Void] = [:]

    init(path: String = SettingsStore.path) {
        self.path = path
        let loaded = Self.load(path)
        settings = loaded.settings
        loadError = loaded.error
    }

    static func load(_ path: String) -> (settings: CaretSettings, error: String?) {
        guard let data = FileManager.default.contents(atPath: path) else {
            return (CaretSettings(), nil)
        }
        do {
            return (try JSONDecoder().decode(CaretSettings.self, from: data), nil)
        } catch {
            let message = "\(path): \(error)"
            FileHandle.standardError.write(Data("caret: settings unreadable, using defaults: \(message)\n".utf8))
            return (CaretSettings(), message)
        }
    }

    /// Changes the settings, records the choices as memory entries and writes the file.
    public func update(source: MemoryEntry.Source, _ change: (inout CaretSettings) -> Void) {
        var next = settings
        change(&next)
        next.recordPreferences(source: source, at: Int64((Date().timeIntervalSince1970 * 1000).rounded()))
        guard next != settings else { return }
        settings = next
        loadError = nil
        save()
        for observer in observers.values { observer(next) }
    }

    @discardableResult
    public func observe(_ body: @escaping (CaretSettings) -> Void) -> UUID {
        let id = UUID()
        observers[id] = body
        return id
    }

    private func save() {
        let url = URL(fileURLWithPath: path)
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(settings).write(to: url, options: .atomic)
        } catch {
            loadError = "\(path): could not write: \(error)"
            FileHandle.standardError.write(Data("caret: \(loadError!)\n".utf8))
        }
    }

    /// The debug socket's `settings` reply.
    public func debugInfo() -> DebugState.SettingsInfo {
        DebugState.SettingsInfo(path: path, error: loadError, settings: settings, gate: settings.gate)
    }

    /// `settings set <name> <value>` on the debug socket, the menu bar's choices by name:
    ///   role fill|repeat|watch|calendar|words on|off, level quiet|balanced|eager,
    ///   paused on|off, routing on|off (H6: "Caret decides when to help"),
    ///   calendar <EventKit calendar id>|default (H8: where accepted events go), keys caret|cotypist
    ///   (which keys take ghost text), app <bundle id> on|off (Caret in one app).
    public func set(_ words: [String]) -> String? {
        func onOff(_ word: String) -> Bool? { word == "on" ? true : (word == "off" ? false : nil) }
        switch (words.first, words.count) {
        case ("role", 3):
            guard let role = CaretRole(rawValue: words[1]), let on = onOff(words[2]) else { return "usage: settings set role fill|repeat|watch|calendar|words on|off" }
            update(source: .socket) { s in if on { s.roles.insert(role) } else { s.roles.remove(role) } }
        case ("level", 2):
            guard let level = CaretLevel(rawValue: words[1]) else { return "usage: settings set level quiet|balanced|eager" }
            update(source: .socket) { $0.level = level }
        case ("paused", 2):
            guard let on = onOff(words[1]) else { return "usage: settings set paused on|off" }
            update(source: .socket) { $0.paused = on }
        case ("routing", 2):
            guard let on = onOff(words[1]) else { return "usage: settings set routing on|off" }
            update(source: .socket) { $0.routing = on }
        case ("calendar", 2):
            // H8: an EventKit calendar identifier, or "default".
            update(source: .socket) { $0.eventCalendar = words[1] == "default" ? nil : words[1] }
        case ("pageInlineText", 2):
            guard let on = onOff(words[1]) else { return "usage: settings set pageInlineText on|off" }
            update(source: .socket) { $0.pageInlineText = on }
        case ("pageInlineContentEditable", 2):
            guard let on = onOff(words[1]) else { return "usage: settings set pageInlineContentEditable on|off" }
            update(source: .socket) { $0.pageInlineContentEditable = on }
        case ("app", 3):
            guard let on = onOff(words[2]), CaretSettings.isBundleID(words[1]) else { return "usage: settings set app <bundle id> on|off" }
            update(source: .socket) { $0.setApp(words[1], off: !on) }
        case ("keys", 2):
            guard let keys = GhostKeys(rawValue: words[1]) else { return "usage: settings set keys caret|cotypist" }
            update(source: .socket) { $0.ghostKeys = keys }
        default:
            return "usage: settings set role|level|paused|routing|calendar|pageInlineText|pageInlineContentEditable|keys|app ..."
        }
        return nil
    }
}
