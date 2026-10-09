import CaretScreenAX
import CaretScreenCore
import Foundation
import Testing

struct DenyListTests {
    private func withFile(_ body: String, check: (String) throws -> Void) throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("caret-required-apps-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let path = dir.appendingPathComponent("deny-apps.txt").path
        try body.write(toFile: path, atomically: true, encoding: .utf8)
        try check(path)
    }

    @Test(arguments: ["com.apple.Terminal", "com.apple.systempreferences", "dev.caret.host"])
    func passwordManagerOnlyFileStillDeniesRequiredApp(_ bundleID: String) throws {
        let body = "# beta.1 exclusions\ncom.1password\ncom.bitwarden.desktop\n"
        try withFile(body) { path in
            let deny = try DenyList.load(path: path)
            let persisted = try String(contentsOfFile: path, encoding: .utf8)
            #expect(deny.denies(bundleID))
            #expect(persisted == body)
        }
    }

    @Test func editingFileCannotRemoveRequiredEntries() throws {
        try withFile(DenyList.defaults.joined(separator: "\n")) { path in
            let before = try DenyList.load(path: path)
            for id in DenyList.defaults { #expect(before.denies(id)) }
            let body = "# all required entries removed\n"
            try body.write(toFile: path, atomically: true, encoding: .utf8)
            let after = try DenyList.load(path: path)
            for id in DenyList.defaults { #expect(after.denies(id)) }
            let persisted = try String(contentsOfFile: path, encoding: .utf8)
            #expect(persisted == body)
        }
    }

    @Test func userAdditionsStillApply() throws {
        let body = "# local additions\n  dev.example.private  \n\n"
        try withFile(body) { path in
            let deny = try DenyList.load(path: path)
            #expect(deny.denies("dev.example.private"))
            #expect(deny.denies("dev.example.private.child"))
            #expect(!deny.denies("dev.example.privatex"))
            let persisted = try String(contentsOfFile: path, encoding: .utf8)
            #expect(persisted == body)
        }
    }

    @Test func readerUsesSharedRequiredExclusions() {
        #expect(DenyList.defaults == ExcludedApps.entries.map(\.bundleIdentifier))
    }

    @Test func directConstructionCannotRemoveRequiredEntries() {
        let deny = DenyList(prefixes: [])
        for id in DenyList.defaults { #expect(deny.denies(id)) }
    }

    @Test func unreadableFileIsAnError() throws {
        try withFile("") { path in
            try FileManager.default.removeItem(atPath: path)
            try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: false)
            #expect(throws: (any Error).self) { try DenyList.load(path: path) }
        }
    }

    @Test func missingFileStartsWithRequiredEntries() throws {
        try withFile("") { path in
            try FileManager.default.removeItem(atPath: path)
            let deny = try DenyList.load(path: path)
            for id in DenyList.defaults { #expect(deny.denies(id)) }
            #expect(FileManager.default.fileExists(atPath: path))
        }
    }
}
