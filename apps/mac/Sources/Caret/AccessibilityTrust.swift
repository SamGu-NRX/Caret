import AppKit
import Foundation
import Security

enum AccessibilityTrust {
    private static let trustedHashKey = "caret.trustedExecutableHash"
    private static let dismissedHashKey = "caret.dismissedRepairForHash"

    static var executablePath: String {
        Bundle.main.executablePath ?? Bundle.main.bundlePath
    }

    /// Stable id for this built binary. macOS Accessibility is tied to the signature, not the name.
    static func executableSignHash() -> String {
        guard let url = Bundle.main.executableURL else { return "unknown" }
        var staticCode: SecStaticCode?
        guard SecStaticCodeCreateWithPath(url as CFURL, [], &staticCode) == errSecSuccess,
              let staticCode
        else { return url.path }

        var info: CFDictionary?
        guard SecCodeCopySigningInformation(
            staticCode,
            SecCSFlags(rawValue: kSecCSSigningInformation),
            &info
        ) == errSecSuccess,
              let info = info as? [String: Any],
              let unique = info[kSecCodeInfoUnique as String] as? Data
        else { return url.path }

        return unique.map { String(format: "%02hhx", $0) }.joined()
    }

    static func isTrusted() -> Bool {
        AXIsProcessTrusted()
    }

    static func noteTrustedIfNeeded() {
        guard isTrusted() else { return }
        UserDefaults.standard.set(executableSignHash(), forKey: trustedHashKey)
    }

    /// ON in System Settings can still apply to an older Caret build after reinstall.
    static func needsRepairPrompt() -> Bool {
        guard !isTrusted() else { return false }
        let hash = executableSignHash()
        if UserDefaults.standard.string(forKey: dismissedHashKey) == hash {
            return false
        }
        return UserDefaults.standard.string(forKey: trustedHashKey) != hash
    }

    static func dismissRepairPromptForCurrentBuild() {
        UserDefaults.standard.set(executableSignHash(), forKey: dismissedHashKey)
    }

    static func openSettings() {
        let urls = [
            "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility",
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        ]
        for string in urls {
            if let url = URL(string: string) {
                NSWorkspace.shared.open(url)
                return
            }
        }
    }
}
