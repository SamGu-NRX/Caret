import Foundation
import XCTest
@testable import CaretScreenAX

/// A deny file an older Caret wrote still gets every default (the helper's readAppsOff does the same).
final class DenyListTests: XCTestCase {
    func testAnOldFileGetsEveryDefaultAndKeepsTheUsersLines() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("deny-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let path = dir.appendingPathComponent("deny-apps.txt").path
        try "# old\ncom.apple.keychainaccess\ncom.example.private\n".write(toFile: path, atomically: true, encoding: .utf8)

        let list = try DenyList.load(path: path)
        XCTAssertTrue(list.denies("com.example.private"))
        for d in DenyList.defaults { XCTAssertTrue(list.denies(d), d) }
        XCTAssertTrue(list.denies("com.apple.Terminal"), "added after the old file was written")
        XCTAssertEqual(Set(list.prefixes).count, list.count, "each prefix once")
    }

    func testAMissingFileIsWrittenWithTheDefaults() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("deny-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let path = dir.appendingPathComponent("deny-apps.txt").path
        let list = try DenyList.load(path: path)
        XCTAssertEqual(list.prefixes, DenyList.defaults)
        XCTAssertTrue(FileManager.default.fileExists(atPath: path))
    }
}
