import Foundation
import Testing
@testable import CaretScreenCore

/// W2: the reader asks Electron apps for their accessibility tree and never a Chromium browser. Bundles are laid out in
/// a temporary directory the way each kind ships.
@Suite struct AppClassifierTests {
    private func bundle(_ paths: [String]) throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("caret-classifier-\(UUID().uuidString)/X.app")
        for p in paths { try FileManager.default.createDirectory(at: root.appendingPathComponent(p), withIntermediateDirectories: true) }
        try FileManager.default.createDirectory(at: root.appendingPathComponent("Contents/MacOS"), withIntermediateDirectories: true)
        return root
    }

    @Test func electronIsElectronAndGetsManualAccessibility() throws {
        // Electron ships its renderer helpers beside the framework, which must not make it a browser.
        let b = try bundle(["Contents/Frameworks/Electron Framework.framework/Versions/A", "Contents/Frameworks/Discordish Helper (Renderer).app"])
        defer { try? FileManager.default.removeItem(at: b.deletingLastPathComponent()) }
        let f = AppClassifier.family(bundleURL: b)
        #expect(f == .electron)
        #expect(f.setsManualAccessibility && f.rendersWithChromium)
    }

    @Test func chromeAndHeliumAreBrowsersAndAreNeverAsked() throws {
        for framework in ["Google Chrome Framework.framework/Versions/154.0.8037.92/Helpers/Google Chrome Helper (Renderer).app",
                          "Helium Framework.framework/Versions/140.0.7339.207/Helpers/Helium Helper (Renderer).app",
                          "Google Chrome for Testing Framework.framework/Versions/154.0.8037.92/Helpers/Google Chrome for Testing Helper (Renderer).app"] {
            let b = try bundle(["Contents/Frameworks/\(framework)"])
            defer { try? FileManager.default.removeItem(at: b.deletingLastPathComponent()) }
            let f = AppClassifier.family(bundleURL: b)
            #expect(f == .chromiumBrowser, "\(framework)")
            #expect(!f.setsManualAccessibility && f.rendersWithChromium)
        }
    }

    @Test func anythingElseIsOtherAndNeverAsked() throws {
        let plain = try bundle([])
        let sparkle = try bundle(["Contents/Frameworks/Sparkle.framework/Versions/B/Resources"])
        defer {
            try? FileManager.default.removeItem(at: plain.deletingLastPathComponent())
            try? FileManager.default.removeItem(at: sparkle.deletingLastPathComponent())
        }
        for b in [plain, sparkle] {
            #expect(AppClassifier.family(bundleURL: b) == .other)
            #expect(!AppClassifier.family(bundleURL: b).setsManualAccessibility)
        }
        #expect(AppClassifier.family(bundleURL: URL(fileURLWithPath: "/nonexistent/Nothing.app")) == .other)
    }
}
