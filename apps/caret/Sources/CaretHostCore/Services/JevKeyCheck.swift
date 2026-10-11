import Foundation

/// The one request onboarding sends to check a Jev key, and what each answer means (H12, lead decision 3).
///
/// The request carries a fixed sentence and one yes/no choice, nothing of the user's: it costs a few dozen input tokens
/// at $0.042 per million (helper/src/fill/jev.ts). The key goes only in its Authorization header.
public enum JevKeyCheck {
    /// The helper's endpoint and model (helper/src/fill/jev.ts JEV_URL, JEV_MODEL).
    public static let url = URL(string: "https://api.typesafe.ai/v1/systemone")!
    public static let model = "jev-latest"
    public static let timeout: TimeInterval = 10

    public enum Outcome: Equatable, Sendable {
        /// 200: Jev answered. Keep the key.
        case works
        /// 402: the key is valid, but its account has no credits. Keep the key and say how to add credits.
        case noCredits
        /// 401 or 403: Jev refused the key. Don't keep it.
        case rejected
        /// No answer: the network is down or Jev didn't respond in time. Try again.
        case unreachable
        /// Any other status (a 429, a 5xx): Jev couldn't say whether the key is good. Try again.
        case unclear(status: Int)

        /// Whether the key is saved after this answer. Only an answer that proves the key authenticates keeps it.
        public var keepsKey: Bool { self == .works || self == .noCredits }
    }

    /// What an HTTP status says about the key. Nil status: no response arrived.
    public static func outcome(status: Int?) -> Outcome {
        switch status {
        case nil: return .unreachable
        case 200?: return .works
        case 402?: return .noCredits
        case 401?, 403?: return .rejected
        case let s?: return .unclear(status: s)
        }
    }

    /// The request body: a fixed state and a fixed question, so nothing from the screen or the user is sent.
    public static let body: Data = {
        let object: [String: Any] = [
            "state": "Caret is checking that this API key works.",
            "model": model,
            "questions": ["check": ["type": "choice", "instructions": "Answer yes.", "criteria": ["yes": NSNull(), "no": NSNull()]]],
        ]
        // A literal of strings and nulls always encodes.
        return (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
    }()

    public static func request(key: String) -> URLRequest {
        var r = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: timeout)
        r.httpMethod = "POST"
        r.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = body
        return r
    }

    /// A key as pasted: surrounding spaces and newlines go; a key with spaces inside is refused before any request.
    public static func cleaned(_ pasted: String) -> String? {
        let key = pasted.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty, !key.contains(where: { $0.isWhitespace }) else { return nil }
        return key
    }
}
