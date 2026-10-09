import Foundation

/// Brief item 4: what the user tells Caret about themselves and how they write, for the completion prompt (KeyType's
/// "Custom writing instructions" section). One "about me" for everywhere, plus instructions for one app or one site.
/// They stay on this Mac: only the local model reads them, and the debug socket shows their lengths, never their text
/// (`DebugState.SettingsInfo`).
public struct PersonalInstructions: Codable, Equatable, Sendable {
    /// KeyType's section holds 384 tokens, and Caret's prompt builder counts 4 characters a token
    /// (`ApproximatePromptTokenCounter`), so about 1,536 characters reach the model. `lines` keeps within it.
    public static let promptCharacters = 384 * 4
    /// The longest one entry may be, so a pasted document is refused at the field rather than cut unseen.
    public static let maxCharacters = 4000

    public var aboutMe = ""
    /// By bundle identifier.
    public private(set) var apps: [String: String] = [:]
    /// By web origin (`SiteOrigin`).
    public private(set) var sites: [String: String] = [:]

    public init() {}

    /// Sets one app's instructions; empty or blank text removes them. An identifier that is not a bundle identifier
    /// changes nothing.
    public mutating func setApp(_ bundleID: String, _ text: String) {
        guard CaretSettings.isBundleID(bundleID) else { return }
        apps[bundleID] = Self.kept(text)
    }

    /// Sets one site's instructions; empty or blank text removes them. Anything not in origin form changes nothing.
    public mutating func setSite(_ origin: String, _ text: String) {
        guard SiteOrigin.isOrigin(origin) else { return }
        sites[origin] = Self.kept(text)
    }

    /// The prompt's lines for a field in `bundleID`, on `origin` when it is a web page: the site's, the app's, then
    /// "about me", within `promptCharacters`. The specific ones come first so a long "about me" is what gets cut, at a
    /// word end.
    public func lines(bundleID: String?, origin: String?) -> [String] {
        var out: [String] = []
        var left = Self.promptCharacters
        func add(_ text: String?) {
            guard let text = text.flatMap(Self.kept), left > 0 else { return }
            let room = left - (out.isEmpty ? 0 : 1)
            let fitted = text.count <= room ? text : Self.cut(text, to: room)
            guard !fitted.isEmpty else { return }
            out.append(fitted)
            left = room - fitted.count
        }
        add(origin.flatMap { sites[$0] })
        add(bundleID.flatMap { apps[$0] })
        add(aboutMe)
        return out
    }

    /// The text trimmed, or nil when nothing is left.
    static func kept(_ text: String) -> String? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }

    /// The longest start of `text` within `limit` characters that ends at a word end.
    static func cut(_ text: String, to limit: Int) -> String {
        guard limit > 0 else { return "" }
        let head = text.prefix(limit)
        if head.count < text.count, let next = text.dropFirst(limit).first, !next.isWhitespace,
           let space = head.lastIndex(where: \.isWhitespace) {
            return String(head[..<space]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return String(head).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    enum CodingKeys: String, CodingKey { case aboutMe, apps, sites }

    /// Strict, as the rest of the settings: an app that is not a bundle identifier, a site that is not an origin, or
    /// an entry over `maxCharacters` refuses the file.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        aboutMe = try c.decodeIfPresent(String.self, forKey: .aboutMe) ?? ""
        apps = try c.decodeIfPresent([String: String].self, forKey: .apps) ?? [:]
        sites = try c.decodeIfPresent([String: String].self, forKey: .sites) ?? [:]
        if let bad = apps.keys.first(where: { !CaretSettings.isBundleID($0) }) {
            throw DecodingError.dataCorruptedError(forKey: .apps, in: c, debugDescription: "'\(bad)' is not a bundle identifier")
        }
        if let bad = sites.keys.first(where: { !SiteOrigin.isOrigin($0) }) {
            throw DecodingError.dataCorruptedError(forKey: .sites, in: c, debugDescription: "'\(bad)' is not a web origin")
        }
        if ([aboutMe] + apps.values + sites.values).contains(where: { $0.count > Self.maxCharacters }) {
            throw DecodingError.dataCorruptedError(forKey: .aboutMe, in: c, debugDescription: "an instruction is longer than \(Self.maxCharacters) characters")
        }
    }

    /// The same, with every text replaced by its length, for the debug socket.
    public var redacted: PersonalInstructions {
        func length(_ t: String) -> String { "\(t.count) characters" }
        var r = self
        r.aboutMe = aboutMe.isEmpty ? "" : length(aboutMe)
        r.apps = apps.mapValues(length)
        r.sites = sites.mapValues(length)
        return r
    }
}
