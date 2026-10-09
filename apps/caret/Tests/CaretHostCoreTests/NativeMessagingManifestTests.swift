import Foundation
import XCTest
import CaretHostCore

// NativeMessagingManifestTests already covers manifest encoding in ServicesRulesTests.swift.
final class NativeMessagingBrowserPlanTests: XCTestCase {
    func testSourcedBrowserIdentifiersAndFolders() {
        let expected: [(BridgeBrowser, String, String)] = [
            (.chrome, "com.google.Chrome", "Google/Chrome"),
            (.helium, "net.imput.helium", "net.imput.helium"),
            (.brave, "com.brave.Browser", "BraveSoftware/Brave-Browser"),
            (.edge, "com.microsoft.edgemac", "Microsoft Edge"),
            (.vivaldi, "com.vivaldi.Vivaldi", "Vivaldi"),
            (.chromium, "org.chromium.Chromium", "Chromium"),
        ]
        XCTAssertEqual(BridgeBrowser.allCases, expected.map(\.0))
        for (browser, id, folder) in expected {
            XCTAssertEqual(browser.bundleIdentifier, id)
            XCTAssertEqual(browser.nativeMessagingDirectory(userHome: "/tmp/browser-plan"),
                           "/tmp/browser-plan/Library/Application Support/\(folder)/NativeMessagingHosts")
            XCTAssertEqual(browser.extensionsPage.absoluteString, "chrome://extensions")
            XCTAssertFalse(browser.displayName.isEmpty)
        }
    }

    func testOnlyChromeAndHeliumAreTrusted() {
        XCTAssertEqual(BridgeBrowser.allCases.filter(\.isTrustedByBridge), [.chrome, .helium])
    }

    func testOnlyInstalledAndTrustedBrowsersGetTargets() {
        let plan = BrowserInstallPlan(homeIsOverride: false, manifestOverride: nil, userHome: "/tmp/browser-plan",
                                      installed: [.brave, .helium, .edge, .helium, .vivaldi, .chromium], defaultBundleID: "com.brave.Browser")
        XCTAssertEqual(plan.installedBrowsers, [.helium, .brave, .edge, .vivaldi, .chromium])
        XCTAssertEqual(plan.untrustedBrowsers, [.brave, .edge, .vivaldi, .chromium])
        XCTAssertEqual(plan.destination, .targets([
            .init(browser: .helium, directory: BridgeBrowser.helium.nativeMessagingDirectory(userHome: "/tmp/browser-plan")),
        ]))
        XCTAssertEqual(plan.pageBrowser, .helium)
        XCTAssertEqual(plan.notices, ["Caret can't connect to Brave yet", "Caret can't connect to Microsoft Edge yet",
                                     "Caret can't connect to Vivaldi yet", "Caret can't connect to Chromium yet"])
    }

    func testDefaultSupportedBrowserWinsOtherwiseFirstTrustedBrowser() {
        for (defaultID, expected) in [("net.imput.helium", BridgeBrowser.helium), ("com.google.Chrome", .chrome),
                                      ("com.brave.Browser", .chrome), ("com.apple.Safari", .chrome)] {
            let plan = BrowserInstallPlan(homeIsOverride: false, manifestOverride: nil, userHome: "/tmp/browser-plan",
                                          installed: BridgeBrowser.allCases, defaultBundleID: defaultID)
            XCTAssertEqual(plan.pageBrowser, expected)
        }
        XCTAssertNil(BrowserInstallPlan.pageBrowser(among: [.brave, .edge], defaultBundleID: "com.brave.Browser"))
    }

    func testNoTrustedInstalledBrowserRefusesWithoutOpeningAPage() {
        for installed: [BridgeBrowser] in [[], [.brave, .edge]] {
            let plan = BrowserInstallPlan(homeIsOverride: false, manifestOverride: nil, userHome: "/tmp/browser-plan",
                                          installed: installed, defaultBundleID: nil)
            guard case .refused = plan.destination else { return XCTFail("No trusted browser must refuse") }
            XCTAssertNil(plan.pageBrowser)
        }
    }

    func testIsolatedHomeRequiresAnExplicitDirectory() {
        let refused = BrowserInstallPlan(homeIsOverride: true, manifestOverride: nil, userHome: "/tmp/browser-plan",
                                         installed: BridgeBrowser.allCases, defaultBundleID: "com.google.Chrome")
        guard case .refused(let why) = refused.destination else { return XCTFail("Isolated home needs --nmh-dir") }
        XCTAssertTrue(why.contains("--nmh-dir"))
        XCTAssertNil(refused.pageBrowser)
    }

    func testOverrideWritesOnlyToTheNamedTemporaryDirectory() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for isolated in [false, true] {
            let plan = BrowserInstallPlan(homeIsOverride: isolated, manifestOverride: directory.path, userHome: "/tmp/browser-plan",
                                          installed: BridgeBrowser.allCases, defaultBundleID: "com.google.Chrome")
            XCTAssertEqual(plan.destination, .targets([.init(browser: nil, directory: directory.path)]))
            XCTAssertNil(plan.pageBrowser)
        }
        let manifest = NativeMessagingManifest(bridgePath: "/tmp/Caret.app/Contents/Helpers/caret-bridge")
        let file = directory.appendingPathComponent(manifest.fileName)
        try manifest.encoded().write(to: file)
        XCTAssertEqual(manifest.plan(existing: try Data(contentsOf: file)), .unchanged)
    }

    func testEmptyOverrideRefusesEvenForTheNormalHome() {
        for isolated in [false, true] {
            let plan = BrowserInstallPlan(homeIsOverride: isolated, manifestOverride: "", userHome: "/tmp/browser-plan",
                                          installed: BridgeBrowser.allCases, defaultBundleID: nil)
            XCTAssertEqual(plan.destination, .refused("the manifest directory given is empty"))
            XCTAssertNil(plan.pageBrowser)
        }
    }

    func testManualStepsRemainAvailableToTheUI() {
        XCTAssertEqual(BrowserInstallPlan.manualSteps.count, 3)
        XCTAssertTrue(BrowserInstallPlan.manualSteps[0].contains("Developer mode"))
        XCTAssertTrue(BrowserInstallPlan.manualSteps[1].contains("Load unpacked"))
        XCTAssertTrue(BrowserInstallPlan.manualSteps[2].contains("Caret for Chrome"))
    }

    func testForeignManifestIsRefusedAndMovedCaretManifestCanBeReplaced() {
        let manifest = NativeMessagingManifest(bridgePath: "/tmp/Caret.app/Contents/Helpers/caret-bridge")
        XCTAssertEqual(manifest.plan(existing: nil), .write)
        guard case .refuse = manifest.plan(existing: Data("not json".utf8)) else { return XCTFail() }
        let foreign = #"{"name":"ai.caret.bridge","description":"x","path":"/tmp/foreign","type":"stdio","allowed_origins":[]}"#
        guard case .refuse = manifest.plan(existing: Data(foreign.utf8)) else { return XCTFail() }
        let moved = NativeMessagingManifest(bridgePath: "/tmp/old/Caret.app/Contents/Helpers/caret-bridge")
        XCTAssertEqual(manifest.plan(existing: moved.encoded()), .replace(previousPath: moved.path))
    }
}
