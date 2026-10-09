import XCTest
import CaretHostCore

final class ExcludedAppsTests: XCTestCase {
    func testEveryEntryHasAReasonAndIsExcluded() {
        for entry in ExcludedApps.entries {
            XCTAssertFalse(entry.reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, entry.bundleIdentifier)
            XCTAssertTrue(entry.reason.hasSuffix("."), entry.bundleIdentifier)
            XCTAssertTrue(ExcludedApps.excludes(bundleID: entry.bundleIdentifier), entry.bundleIdentifier)
        }
    }

    func testReaderDefaultIdentifiersArePreserved() {
        let readerDefaults = [
            "com.apple.keychainaccess", "com.apple.Passwords", "com.bitwarden.desktop", "com.1password", "com.agilebits",
            "com.lastpass", "com.dashlane", "com.callpod.keeper", "org.keepassxc", "me.proton.pass", "ch.protonmail.pass",
            "in.sinew.Enpass", "com.nordsec.nordpass", "com.apple.systempreferences.passwords",
        ]
        let identifiers = Set(ExcludedApps.entries.map(\.bundleIdentifier))
        for id in readerDefaults { XCTAssertTrue(identifiers.contains(id), id) }
    }

    func testPrefixesMatchOnlyDotSeparatedDescendants() throws {
        let entry = try XCTUnwrap(ExcludedApps.entries.first { $0.bundleIdentifier == "com.1password" })
        XCTAssertTrue(entry.matches("com.1password"))
        XCTAssertTrue(entry.matches("com.1password.1password"))
        XCTAssertFalse(entry.matches("com.1passwordx"))
        XCTAssertFalse(entry.matches("com.1pass"))
        XCTAssertFalse(entry.matches("other.com.1password"))
    }

    func testCaretAndSystemSettingsAreExcluded() {
        for id in ["dev.caret.host", "dev.caret.bridge", "dev.caret.screen", "dev.caret.helper.child",
                   "com.apple.systempreferences", "com.apple.systempreferences.passwords"] {
            XCTAssertTrue(ExcludedApps.excludes(bundleID: id), id)
        }
        XCTAssertFalse(ExcludedApps.excludes(bundleID: "dev.caretx.host"))
        XCTAssertFalse(ExcludedApps.excludes(bundleID: "com.apple.systempreferencesx"))
    }

    func testNormalAppsAreNotExcluded() {
        for id in ["com.apple.TextEdit", "com.apple.mail", "com.google.Chrome"] {
            XCTAssertFalse(ExcludedApps.excludes(bundleID: id), id)
        }
        XCTAssertFalse(ExcludedApps.excludes(bundleID: nil))
    }

    func testTerminalsAreExcluded() {
        for id in ["com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable", "com.mitchellh.ghostty",
                   "com.mitchellh.ghostty.debug", "org.alacritty", "net.kovidgoyal.kitty", "com.github.wez.wezterm"] {
            XCTAssertTrue(ExcludedApps.excludes(bundleID: id), id)
        }
    }

    func testSecureInputStopsOffersEverywhere() {
        XCTAssertFalse(ExcludedApps.allowsOffers(secureInputEnabled: true))
        XCTAssertTrue(ExcludedApps.allowsOffers(secureInputEnabled: false))
    }

    func testNoDuplicateIdentifiers() {
        let ids = ExcludedApps.entries.map(\.bundleIdentifier)
        XCTAssertEqual(Set(ids).count, ids.count)
    }

    func testNoEarnedTrustAlwaysNeedsAnOffer() {
        XCTAssertEqual(NoEarnedTrust().standing(action: "fill", bundleID: "com.apple.TextEdit"), .offerEachTime)
        XCTAssertEqual(NoEarnedTrust().standing(action: "", bundleID: ""), .offerEachTime)
    }
}
