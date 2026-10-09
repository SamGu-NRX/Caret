/// Apps Caret must not read, offer into or write into, each with the reason a person would read. The host refuses them
/// here (`TargetPolicy`); the reader's and the helper's default deny lists hold the same identifiers, so nothing from
/// these apps is walked or sent either (ExcludedAppsTests checks the reader's list holds every one).
public enum ExcludedApps {
    public enum Kind: String, Sendable {
        case passwordManager, keychain, terminal, systemSettings, caret
    }

    public struct Entry: Equatable, Sendable {
        public let bundleIdentifier: String
        public let kind: Kind
        public let reason: String

        /// A prefix matches itself and dot-separated descendants, never a sibling such as com.1passwordx.
        public func matches(_ bundleID: String) -> Bool {
            bundleID == bundleIdentifier || bundleID.hasPrefix(bundleIdentifier + ".")
        }
    }

    public static let entries: [Entry] = [
        // Exact identifiers from CaretScreenAX/ScreenReader.swift DenyList.defaults.
        Entry(bundleIdentifier: "com.apple.keychainaccess", kind: .keychain, reason: "Caret leaves your saved keys and credentials alone."),
        Entry(bundleIdentifier: "com.apple.Passwords", kind: .passwordManager, reason: "Caret leaves your passwords alone."),
        Entry(bundleIdentifier: "com.bitwarden.desktop", kind: .passwordManager, reason: "Caret leaves your Bitwarden vault alone."),
        Entry(bundleIdentifier: "com.1password", kind: .passwordManager, reason: "Caret leaves your 1Password vault alone."),
        Entry(bundleIdentifier: "com.agilebits", kind: .passwordManager, reason: "Caret leaves your 1Password vault alone."),
        Entry(bundleIdentifier: "com.lastpass", kind: .passwordManager, reason: "Caret leaves your LastPass vault alone."),
        Entry(bundleIdentifier: "com.dashlane", kind: .passwordManager, reason: "Caret leaves your Dashlane vault alone."),
        Entry(bundleIdentifier: "com.callpod.keeper", kind: .passwordManager, reason: "Caret leaves your Keeper vault alone."),
        Entry(bundleIdentifier: "org.keepassxc", kind: .passwordManager, reason: "Caret leaves your KeePassXC vault alone."),
        Entry(bundleIdentifier: "me.proton.pass", kind: .passwordManager, reason: "Caret leaves your Proton Pass vault alone."),
        Entry(bundleIdentifier: "ch.protonmail.pass", kind: .passwordManager, reason: "Caret leaves your Proton Pass vault alone."),
        Entry(bundleIdentifier: "in.sinew.Enpass", kind: .passwordManager, reason: "Caret leaves your Enpass vault alone."),
        Entry(bundleIdentifier: "com.nordsec.nordpass", kind: .passwordManager, reason: "Caret leaves your NordPass vault alone."),
        Entry(bundleIdentifier: "com.apple.systempreferences.passwords", kind: .systemSettings, reason: "Caret leaves your password settings alone."),
        // All seven terminal IDs below are in KeyType at pinned commit 21df2cc1f5271d3712d567e3c2491ac09174caf3,
        // Packages/MacContextCapture/Sources/MacContextCapture/Accessibility/FocusedFieldReader.swift terminalBundleIDs.
        // Ghostty's dot-separated debug ID is also in that list and is covered by prefix matching.
        Entry(bundleIdentifier: "com.apple.Terminal", kind: .terminal, reason: "Caret leaves terminal commands to you."),
        Entry(bundleIdentifier: "com.googlecode.iterm2", kind: .terminal, reason: "Caret leaves iTerm2 commands to you."),
        Entry(bundleIdentifier: "dev.warp.Warp-Stable", kind: .terminal, reason: "Caret leaves Warp commands to you."),
        Entry(bundleIdentifier: "com.mitchellh.ghostty", kind: .terminal, reason: "Caret leaves Ghostty commands to you."),
        Entry(bundleIdentifier: "org.alacritty", kind: .terminal, reason: "Caret leaves Alacritty commands to you."),
        Entry(bundleIdentifier: "net.kovidgoyal.kitty", kind: .terminal, reason: "Caret leaves kitty commands to you."),
        Entry(bundleIdentifier: "com.github.wez.wezterm", kind: .terminal, reason: "Caret leaves WezTerm commands to you."),
        // mdls -name kMDItemCFBundleIdentifier /System/Applications/System\ Settings.app on this Mac.
        Entry(bundleIdentifier: "com.apple.systempreferences", kind: .systemSettings, reason: "Caret leaves changes to your Mac's settings to you."),
        // Caret.app and its helpers (apps/caret/scripts/build-app.sh): exact identifiers, so the test fixture app
        // dev.caret.fixture stays a target for runs that name its pid.
        Entry(bundleIdentifier: "dev.caret.host", kind: .caret, reason: "Caret does not read or offer into its own windows."),
        Entry(bundleIdentifier: "dev.caret.screen", kind: .caret, reason: "Caret does not read or offer into its own helpers."),
        Entry(bundleIdentifier: "dev.caret.node", kind: .caret, reason: "Caret does not read or offer into its own helpers."),
        Entry(bundleIdentifier: "dev.caret.bridge", kind: .caret, reason: "Caret does not read or offer into its own helpers."),
    ]

    public static func excludes(bundleID: String?) -> Bool {
        guard let bundleID else { return false }
        return entries.contains { $0.matches(bundleID) }
    }

    /// Secure event input silences offers in every app, even when its focused field is not marked secure.
    public static func allowsOffers(secureInputEnabled: Bool) -> Bool {
        !secureInputEnabled
    }
}
