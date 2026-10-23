import Foundation

/// What Caret never keeps in memory, by kind. The kinds, words and value shapes are the helper's
/// (`helper/src/memory/sensitive.ts`), ported for text the host saves itself. Both ports answer every
/// case in `helper/fixtures/sensitive-cases.json`, and each side's test reads that file, so a change
/// to one that the other lacks fails a test.
public enum SensitiveKind: String, Error, Equatable, Sendable, CaseIterable {
    case password, cardNumber, accountNumber, governmentId, oneTimeCode, apiKey

    /// How a refusal names the kind, after "Caret doesn't keep" (`SENSITIVE_SAYS`).
    public var says: String {
        switch self {
        case .password: "passwords"
        case .cardNumber: "card numbers"
        case .accountNumber: "account numbers"
        case .governmentId: "government ID numbers"
        case .oneTimeCode: "one-time codes"
        case .apiKey: "API keys or tokens"
        }
    }

    public var message: String { "Caret doesn't keep \(says) in memory" }
}

public enum SensitiveText {
    /// The kind of secret a text holds or states, or nil: a value's shape first, then a stated secret, the order the
    /// helper checks a saved answer in (`parse.ts`). Text that only mentions a kind ("never suggest passwords") is nil.
    public static func kind(in text: String) -> SensitiveKind? {
        valueKind(text) ?? statedSecretMatch(text)?.kind
    }

    // MARK: Value shapes (`valueKind`)

    /// `API_KEY_SHAPES`. Case-sensitive, so they run on the text as written.
    private static let apiKeyShapes = [
        #"\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)[-_][A-Za-z0-9_-]{12,}"#,
        #"\bsk-[A-Za-z0-9_-]{20,}"#,
        #"\bgh[pousr]_[A-Za-z0-9]{30,}"#,
        #"\bgithub_pat_[A-Za-z0-9_]{20,}"#,
        #"\bxox[abprs]-[A-Za-z0-9-]{10,}"#,
        #"\bAKIA[0-9A-Z]{16}\b"#,
        #"\bAIza[0-9A-Za-z_-]{35}\b"#,
        #"\bgsk_[A-Za-z0-9]{20,}"#,
        #"-----BEGIN [A-Z ]*PRIVATE KEY-----"#,
        #"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}"#,
    ].map(regex)
    /// A US social security number written with its dashes.
    private static let ssn = regex(#"\b[0-9]{3}-[0-9]{2}-[0-9]{4}\b"#)
    /// An IBAN: country in capitals, check digits, then 11 to 30 letters and digits, spaces allowed every four.
    private static let iban = regex(#"\b[A-Z]{2}[0-9]{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b"#)
    /// Runs of digits with spaces or dashes between, as a card number is written.
    private static let digitRun = regex(#"[0-9](?:[ -]?[0-9]){12,18}"#)

    /// The kind a value's shape gives away, or nil: a known API or private key format, a dashed SSN, an IBAN, or a
    /// Luhn-valid run of 13 to 19 digits. A phone number, a date or an order number does not match.
    public static func valueKind(_ value: String) -> SensitiveKind? {
        if apiKeyShapes.contains(where: { found($0, in: value) }) { return .apiKey }
        if found(ssn, in: value) { return .governmentId }
        if found(iban, in: value) { return .accountNumber }
        let ns = value as NSString
        for run in digitRun.matches(in: value, range: NSRange(location: 0, length: ns.length)) {
            let digits = ns.substring(with: run.range).filter(\.isASCII).filter(\.isNumber)
            if (13...19).contains(digits.count), luhn(digits) { return .cardNumber }
        }
        return nil
    }

    static func luhn(_ digits: String) -> Bool {
        var sum = 0
        var double = false
        for scalar in digits.unicodeScalars.reversed() {
            var d = Int(scalar.value) - 48
            if double { d *= 2; if d > 9 { d -= 9 } }
            sum += d
            double.toggle()
        }
        return sum % 10 == 0
    }

    // MARK: Stated secrets (`statedSecretMatch`)

    /// `LABEL_PHRASES`, in its order: the first phrase that matches names the kind.
    static let labelPhrases: [(SensitiveKind, [[String]])] = [
        (.oneTimeCode, [["otp"], ["one", "time"], ["verification", "code"], ["2fa"], ["mfa"], ["auth", "code"], ["authentication", "code"], ["login", "code"], ["sms", "code"], ["security", "code", "sent"]]),
        (.cardNumber, [["card", "number"], ["card", "no"], ["credit", "card"], ["debit", "card"], ["cvv"], ["cvc"], ["cvv2"], ["csc"], ["security", "code"], ["card", "verification"]]),
        (.password, [["password"], ["passwd"], ["passcode"], ["passphrase"], ["pin"], ["pin", "code"]]),
        (.accountNumber, [["account", "number"], ["account", "no"], ["acct"], ["routing", "number"], ["routing"], ["iban"], ["swift"], ["bic"], ["sort", "code"], ["bank", "account"], ["aba"]]),
        (.governmentId, [["ssn"], ["social", "security"], ["sin"], ["passport"], ["driver", "license"], ["drivers", "license"], ["driving", "licence"], ["license", "number"], ["licence", "number"], ["tax", "id"], ["tin"], ["ein"], ["itin"], ["national", "id"], ["national", "insurance"], ["government", "id"]]),
        (.apiKey, [["api", "key"], ["apikey"], ["api", "token"], ["access", "token"], ["access", "key"], ["secret"], ["private", "key"], ["token"], ["client", "secret"], ["bearer"]]),
    ]

    /// `COMMON_IN_SENTENCES`: phrases ordinary sentences use for other things ("pin it", "a token of thanks", "the
    /// secret is consistency"). One counts when owned by "my" or "our", or used as a ":" or "=" label, and with a digit
    /// in the first three words of its value.
    static let commonInSentences: Set<String> = ["pin", "sin", "tin", "swift", "routing", "token", "secret", "bic", "aba", "csc", "bearer", "acct", "one time"]

    /// A stated secret: its kind, the text after "is" or ":" up to the end of the sentence (lowercased), and the value's
    /// first one, two and three words, which is what a caller binds a refusal to.
    public struct StatedSecret: Equatable, Sendable {
        public let kind: SensitiveKind
        public let value: String
        public let candidates: [String]
    }

    private struct Phrase {
        let kind: SensitiveKind
        let common: Bool
        let owned: NSRegularExpression
        let bare: NSRegularExpression
    }

    /// One owned and one bare pattern per phrase, as `statedSecretMatch` builds them. `\w` there is ASCII (a `u`-flag
    /// JavaScript regex), so it is spelled out; `$` there is the end of the text, `\z` here.
    private static let phrases: [Phrase] = labelPhrases.flatMap { kind, phrases in
        phrases.map { words in
            let common = commonInSentences.contains(words.joined(separator: " "))
            let phrase = words.map(NSRegularExpression.escapedPattern(for:)).joined(separator: #"[\s-]+"#)
            let tail = #"s?(?:\s+(?:number|no|num|nr|code|id))?(?:\s+(?:for|of|to|on|at)(?:\s+[A-Za-z0-9_'-]+){1,3})?"#
            let value = #"(?<secret>[^\n.;!?]+?)"#
            let suffix = #"(?=\z|[\n.;!?])"#
            let owners = common ? "my|our" : "my|our|the"
            return Phrase(
                kind: kind,
                common: common,
                owned: regex(#"\b(?:\#(owners))\s+(?:[A-Za-z0-9_'-]+\s+)?"# + phrase + tail + #"\s*(?:is|was|:|=)\s*"# + value + suffix),
                bare: regex(#"(?:^|[\n.;!?(]\s*|\s)"# + phrase + tail + #"\s*[:=]\s*"# + value + suffix)
            )
        }
    }

    /// Strips what is not a letter, a digit, `'`, `_` or `-` from a word's two ends.
    private static let wordEdges = regex(#"^[^\p{L}\p{N}'_-]+|[^\p{L}\p{N}'_-]+$"#)

    /// The kind of secret a text states, and its value: "My password is violet-orchard-seven", "my password for the
    /// portal is aaaaaa, put it in Notes", "Password: …", "my PIN is 7319". A label phrase owned ("my", "our", "the") and
    /// followed by "is", "was", ":" or "=", or bare and followed by ":" or "=", then a value. A common phrase needs "my"
    /// or "our" unless used as a ":" or "=" label. It also needs a digit in the value's first three words.
    public static func statedSecretMatch(_ text: String) -> StatedSecret? {
        let t = text.lowercased()
        let range = NSRange(location: 0, length: (t as NSString).length)
        for p in phrases {
            // Explicit labels such as "One-time code: 123456" and "PIN: 7319" need no owner, even for common phrases.
            guard let match = p.owned.firstMatch(in: t, range: range) ?? p.bare.firstMatch(in: t, range: range) else { continue }
            let span = match.range(withName: "secret")
            guard span.location != NSNotFound else { continue }
            let secret = (t as NSString).substring(with: span).trimmingCharacters(in: .whitespacesAndNewlines)
            if secret.isEmpty { continue }
            let words = secret.split(whereSeparator: \.isWhitespace).map { word -> String in
                let w = String(word)
                return wordEdges.stringByReplacingMatches(in: w, range: NSRange(location: 0, length: (w as NSString).length), withTemplate: "")
            }.filter { !$0.isEmpty }
            let candidates = (0..<min(3, words.count)).map { words[...$0].joined(separator: " ") }
            if candidates.isEmpty { continue }
            if p.common, !candidates.contains(where: { $0.unicodeScalars.contains { (48...57).contains($0.value) } }) { continue }
            return StatedSecret(kind: p.kind, value: secret, candidates: candidates)
        }
        return nil
    }

    // MARK: -

    private static func regex(_ pattern: String) -> NSRegularExpression {
        do { return try NSRegularExpression(pattern: pattern) } catch { preconditionFailure("bad pattern \(pattern): \(error)") }
    }

    private static func found(_ re: NSRegularExpression, in text: String) -> Bool {
        re.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length)) != nil
    }
}
