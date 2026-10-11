import CaretHostCore
import CaretScreenCore
import XCTest
@testable import CaretHost

/// The settings file: written on change, read back on launch, and never guessed at when it holds
/// something this host does not understand.
@MainActor
final class SettingsStoreTests: XCTestCase {
    private var dir: URL!

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("caret-settings-\(UUID().uuidString)")
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private var path: String { dir.appendingPathComponent("settings.json").path }

    func testAChangeIsWrittenAndReadBackByTheNextLaunch() throws {
        let store = SettingsStore(path: path)
        store.update(source: .onboarding) { s in
            s.roles = [.fill, .words]
            s.level = .quiet
            s.onboarded = true
        }
        let next = SettingsStore(path: path)
        XCTAssertNil(next.loadError)
        XCTAssertEqual(next.settings.roles, [.fill, .words])
        XCTAssertEqual(next.settings.level, .quiet)
        XCTAssertTrue(next.settings.onboarded)
        XCTAssertEqual(next.settings.memory.first { $0.key == "role.watch" }?.value, "off")
        XCTAssertEqual(next.settings.memory.first?.source, .onboarding)
    }

    /// H8: the calendar picked in What Caret knows, saved where the reader reads it.
    func testTheCalendarChoiceIsWrittenAndReadBackByTheNextLaunch() throws {
        SettingsStore(path: path).update(source: .menu) { $0.eventCalendar = "work-1" }
        XCTAssertEqual(SettingsStore(path: path).settings.eventCalendar, "work-1")
        XCTAssertEqual(try CalendarChoiceFile.read(path), "work-1")
        SettingsStore(path: path).update(source: .menu) { $0.eventCalendar = nil }
        XCTAssertNil(SettingsStore(path: path).settings.eventCalendar)
        XCTAssertNil(try CalendarChoiceFile.read(path), "back to the default")
    }

    func testAnUnreadableFileIsReportedAndLeftAloneUntilTheUserChangesSomething() throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data(#"{"version":9}"#.utf8).write(to: URL(fileURLWithPath: path))
        let store = SettingsStore(path: path)
        XCTAssertNotNil(store.loadError)
        XCTAssertEqual(store.settings, CaretSettings())
        XCTAssertEqual(try String(contentsOfFile: path, encoding: .utf8), #"{"version":9}"#)
        XCTAssertNotNil(store.debugInfo().error)
    }

    func testTheSocketsSetCommandTakesTheMenusChoicesByName() {
        let store = SettingsStore(path: path)
        XCTAssertNil(store.set(["role", "watch", "off"]))
        XCTAssertNil(store.set(["level", "eager"]))
        XCTAssertNil(store.set(["paused", "on"]))
        XCTAssertFalse(store.settings.roles.contains(.watch))
        XCTAssertEqual(store.settings.level, .eager)
        XCTAssertTrue(store.settings.paused)
        XCTAssertNotNil(store.set(["role", "fly", "off"]))
        XCTAssertNotNil(store.set(["level", "loud"]))
        XCTAssertNotNil(store.set(["paused", "maybe"]))
        XCTAssertEqual(store.settings.memory.first { $0.key == "level" }?.source, .socket)
    }

    func testObserversHearEachRealChangeOnce() {
        let store = SettingsStore(path: path)
        var heard: [CaretLevel] = []
        store.observe { heard.append($0.level) }
        store.update(source: .menu) { $0.level = .eager }
        store.update(source: .menu) { $0.level = .eager }
        XCTAssertEqual(heard, [.eager])
    }
}
