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

    func testAnUnreadableFileThatCannotBeMovedYetIsNeverOverwritten() throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data(#"{"version":9}"#.utf8).write(to: URL(fileURLWithPath: path))
        let store = SettingsStore(path: path)
        // The folder turns read-only: the move aside fails, and the change must not be written over the file.
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: dir.path)
        store.update(source: .onboarding) { $0.roles = [.words] }
        XCTAssertTrue(store.lastWriteFailed)
        XCTAssertEqual(try String(contentsOfFile: path, encoding: .utf8), #"{"version":9}"#, "still the unreadable file")
        // Writable again: the next change keeps it aside first, then writes.
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir.path)
        store.update(source: .onboarding) { $0.roles = [.words, .fill] }
        XCTAssertFalse(store.lastWriteFailed)
        let kept = try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasPrefix("settings.json.unreadable-") }
        XCTAssertEqual(kept.count, 1)
        XCTAssertEqual(try String(contentsOfFile: dir.appendingPathComponent(kept[0]).path, encoding: .utf8), #"{"version":9}"#)
    }

    func testAFailedWriteIsReportedUntilAWriteSucceeds() throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        // The settings path's folder is a file: nothing can be written under it.
        let blocked = dir.appendingPathComponent("not-a-folder")
        try Data("x".utf8).write(to: blocked)
        let store = SettingsStore(path: blocked.appendingPathComponent("settings.json").path)
        store.update(source: .onboarding) { $0.onboarded = true }
        XCTAssertTrue(store.lastWriteFailed, "onboarding's completion is in memory only; the hand-off must not go")
        XCTAssertTrue(store.settings.onboarded)
        let fine = SettingsStore(path: path)
        fine.update(source: .onboarding) { $0.onboarded = true }
        XCTAssertFalse(fine.lastWriteFailed)
    }

    func testTheFirstWriteAfterAnUnreadableFileKeepsThatFileAside() throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data(#"{"version":9}"#.utf8).write(to: URL(fileURLWithPath: path))
        let store = SettingsStore(path: path)
        // Onboarding holds the cloud roles without the person changing anything.
        store.update(source: .onboarding) { $0.roles = [.words] }
        let kept = try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasPrefix("settings.json.unreadable-") }
        XCTAssertEqual(kept.count, 1)
        XCTAssertEqual(try String(contentsOfFile: dir.appendingPathComponent(kept[0]).path, encoding: .utf8), #"{"version":9}"#)
        XCTAssertNil(SettingsStore(path: path).loadError, "the new file is readable")
        store.update(source: .onboarding) { $0.roles = [.words, .fill] }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasPrefix("settings.json.unreadable-") }.count, 1, "kept once")
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
