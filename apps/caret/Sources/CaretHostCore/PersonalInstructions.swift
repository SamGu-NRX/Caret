import Foundation

private extension String {
    func matchesLuhnDigitRun() -> Bool {
        let digits = filter(\.isNumber)
        guard digits.count >= 13, digits.count <= 19 else { return false }
        var sum = 0
        var double = false
        for scalar in digits.unicodeScalars.reversed() {
            var value = Int(scalar.value - 48)
            if double { value *= 2; if value > 9 { value -= 9 } }
            sum += value
            double.toggle()
        }
        return sum % 10 == 0
    }
}

/// Brief item 4: what the user tells Caret about themselves and how they write, for the completion prompt (KeyType's
/// "Custom writing instructions" section). One "about me" for everywhere, plus instructions for one app or one site.
/// They stay on this Mac: only the local model reads them, and the debug socket shows their lengths, never their text
/// (`DebugState.SettingsInfo`).
public struct PersonalInstructions: Codable, Equatable, Sendable {
    public enum SaveRefusal: String, Error, Equatable, Sendable {
        case password = "passwords"
        case cardNumber = "card numbers"
        case accountNumber = "account numbers"
        case governmentId = "government ID numbers"
        case oneTimeCode = "one-time codes"
        case apiKey = "API keys or tokens"

        public var message: String { "Caret doesn't keep \(rawValue) in memory" }
    }

    /// Returns the named reason when text states or contains a secret that must not reach local memory.
    public static func refusal(for text: String) -> SaveRefusal? {
        let lower = text.lowercased()
        let stated: [(SaveRefusal, String)] = [
            (.oneTimeCode, #"(?:my|our|the)\s+(?:[\w'-]+\s+)?(?:one[\s-]*time|otp|2fa|mfa|verification|authentication|login|sms|security)\s*(?:code)?(?:\s+for\s+[\w'-]+){0,3}\s*(?:is|was|:|=)\s*\S"#),
            (.cardNumber, #"(?:my|our|the)\s+(?:[\w'-]+\s+)?(?:card|credit card|debit card)\s*(?:number|no)?\s*(?:is|was|:|=)\s*\S"#),
            (.password, #"(?:my|our|the)\s+(?:[\w'-]+\s+)?(?:password|passwd|passcode|passphrase|pin)(?:\s+(?:code|number))?(?:\s+for\s+[\w'-]+){0,3}\s*(?:is|was|:|=)\s*\S"#),
            (.accountNumber, #"(?:my|our|the)\s+(?:[\w'-]+\s+)?(?:account|routing|iban|swift|bic|sort code|bank account)(?:\s+(?:number|no|code|id))?\s*(?:is|was|:|=)\s*\S"#),
            (.governmentId, #"(?:my|our|the)\s+(?:[\w'-]+\s+)?(?:ssn|social security|sin|passport|driver license|driving licence|tax id|tin|ein|itin|national id|government id)(?:\s+(?:number|no|code|id))?\s*(?:is|was|:|=)\s*\S"#),
            (.apiKey, #"(?:my|our|the)\s+(?:[\w'-]+\s+)?(?:api[\s-]*(?:key|token)|access (?:key|token)|secret|private key|client secret|bearer)(?:\s+for\s+[\w'-]+){0,3}\s*(?:is|was|:|=)\s*\S"#)
        ]
        for (kind, pattern) in stated where lower.range(of: pattern, options: .regularExpression) != nil { return kind }
        if lower.range(of: #"\b\d(?:[ -]?\d){12,18}\b"#, options: .regularExpression) != nil,
           lower.matchesLuhnDigitRun() { return .cardNumber }
        if lower.range(of: #"\b\d{3}-\d{2}-\d{4}\b"#, options: .regularExpression) != nil { return .governmentId }
        if lower.range(of: #"\b[a-z]{2}\d{2}(?: ?[a-z0-9]{4}){2,7}(?: ?[a-z0-9]{1,3})?\b"#, options: .regularExpression) != nil { return .accountNumber }
        let shapes = [#"\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)[-_][A-Za-z0-9_-]{12,}"#, #"\bsk-[A-Za-z0-9_-]{20,}"#, #"\bgh[pousr]_[A-Za-z0-9]{30,}"#, #"\bgithub_pat_[A-Za-z0-9_]{20,}"#, #"\b(?:xox[abprs])-[A-Za-z0-9-]{10,}"#, #"\bAKIA[0-9A-Z]{16}\b"#, #"\bAIza[0-9A-Za-z_-]{35}\b"#, #"\bgsk_[A-Za-z0-9]{20,}"#, #"-----BEGIN [A-Z ]*PRIVATE KEY-----"#, #"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}"#]
        if shapes.contains(where: { lower.range(of: $0, options: .regularExpression) != nil }) { return .apiKey }
        return nil
    }

    @discardableResult
    public mutating func setAboutMe(_ text: String) -> SaveRefusal? {
        if let refusal = Self.refusal(for: text) { return refusal }
        aboutMe = Self.kept(text) ?? ""
        return nil
    }
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
    @discardableResult
    public mutating func setApp(_ bundleID: String, _ text: String) -> SaveRefusal? {
        guard CaretSettings.isBundleID(bundleID) else { return nil }
        if let refusal = Self.refusal(for: text) { return refusal }
        apps[bundleID] = Self.kept(text)
        return nil
    }

    /// Sets one site's instructions; empty or blank text removes them. Anything not in origin form changes nothing.
    @discardableResult
    public mutating func setSite(_ origin: String, _ text: String) -> SaveRefusal? {
        guard SiteOrigin.isOrigin(origin) else { return nil }
        if let refusal = Self.refusal(for: text) { return refusal }
        sites[origin] = Self.kept(text)
        return nil
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
