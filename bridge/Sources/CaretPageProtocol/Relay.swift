import Foundation

/// What the bridge lets through after the handshake: one JSON object per message, whose `type` its direction allows,
/// with no raw newline (the socket side is NDJSON). The helper validates every field with zod; the bridge only keeps
/// the extension from speaking for the helper and the reverse.
public enum Relay {
    public enum Refusal: Error, Equatable, CustomStringConvertible {
        case notJSONObject
        case newline
        case type(String?)
        public var description: String {
            switch self {
            case .notJSONObject: "not a JSON object"
            case .newline: "holds a raw newline"
            case let .type(t): "type \(t ?? "missing") may not travel this way"
            }
        }
    }

    /// The message's type if `payload` may travel in `direction`, else why not.
    public static func admit(_ payload: Data, _ direction: Direction) -> Result<String, Refusal> {
        if payload.contains(0x0A) { return .failure(.newline) }
        guard let obj = try? JSONSerialization.jsonObject(with: payload), let dict = obj as? [String: Any] else { return .failure(.notJSONObject) }
        let type = dict["type"] as? String
        guard let t = type, direction.allowed.contains(t) else { return .failure(.type(type)) }
        return .success(t)
    }

    /// The extension id in the origin Chrome passes a native host, "chrome-extension://<id>/", or nil.
    public static func extensionId(fromOrigin origin: String) -> String? {
        let prefix = "chrome-extension://"
        guard origin.hasPrefix(prefix) else { return nil }
        var id = String(origin.dropFirst(prefix.count))
        if id.hasSuffix("/") { id.removeLast() }
        guard id.count == 32, id.utf8.allSatisfy({ $0 >= 97 && $0 <= 112 }) else { return nil }
        return id
    }
}
