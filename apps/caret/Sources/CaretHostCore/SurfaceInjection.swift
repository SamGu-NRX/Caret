import Foundation

/// An offer handed to the host through the debug socket's `inject` command, for tests and
/// screenshots. The same shapes are what the helper will send once the screen track adds offer
/// messages; until then only the debug socket produces them, and their claims are never reported
/// to the helper (`OfferSource.debug`).
///
/// ```
/// {"kind":"alternatives","pid":123,"candidates":["…","…"]}
/// {"kind":"action","pid":123,"offerKey":"k","app":"Calendar","endState":{"text":"…","ref":{…}},
///  "actions":[{"id":"add","label":"Add","key":"tab"}],"variants":<PopupSpec>?}
/// {"kind":"popup","pid":123,"offerKey":"k","spec":<PopupSpec>}
/// {"kind":"helperLine","line":<one helper protocol message>}
/// ```
public enum SurfaceInjection: Equatable, Sendable {
    case alternatives(pid: Int32, candidates: [String])
    case action(pid: Int32, ActionLine)
    case popup(pid: Int32, PopupOffer)
    /// A raw helper message (a `fillProposal`), delivered as if the helper had sent it.
    case helperLine(Data)

    public struct Invalid: Error, Equatable, CustomStringConvertible {
        public let description: String
        init(_ description: String) { self.description = description }
    }

    public static func decode(_ data: Data) throws -> SurfaceInjection {
        let json: JSON
        do { json = try JSONDecoder().decode(JSON.self, from: data) } catch { throw Invalid("not JSON") }
        guard case .object(let o) = json, case .string(let kind)? = o["kind"] else { throw Invalid("needs an object with kind") }
        func pid() throws -> Int32 {
            guard case .number(let n)? = o["pid"], n > 0, n == n.rounded() else { throw Invalid("needs a pid") }
            return Int32(n)
        }
        func string(_ key: String) throws -> String {
            guard case .string(let s)? = o[key], !s.isEmpty else { throw Invalid("needs \(key)") }
            return s
        }
        func spec(_ value: JSON?) throws -> PopupSpec {
            guard let value else { throw Invalid("needs spec") }
            do { return try PopupSpec.parse(value) } catch let error as PopupSpecError { throw Invalid("spec: \(error)") }
        }
        switch kind {
        case "alternatives":
            guard case .array(let raw)? = o["candidates"] else { throw Invalid("needs candidates") }
            let candidates = raw.compactMap { if case .string(let s) = $0 { return s } else { return nil } }
            guard !candidates.isEmpty, candidates.count == raw.count, candidates.allSatisfy({ !$0.isEmpty }) else {
                throw Invalid("candidates must be non-empty strings")
            }
            return .alternatives(pid: try pid(), candidates: candidates)
        case "action":
            guard let endState = o["endState"], case .array(let rawActions)? = o["actions"] else {
                throw Invalid("needs endState and actions")
            }
            do {
                let value = try PopupSpec.parseValue(endState, path: "endState")
                // The bar as a pop-up's actions block, so it follows the same rules.
                let bar = try PopupSpec.parseBlock(.object(["type": .string("actions"), "items": .array(rawActions)]), path: "actions")
                guard case .actions(let actions) = bar.content, actions.items.contains(where: { $0.key == .tab }) else {
                    throw Invalid("actions need a tab action")
                }
                let variants = try o["variants"].map(spec)
                return .action(pid: try pid(), ActionLine(
                    offerKey: try string("offerKey"), app: try string("app"), endState: value,
                    actions: actions.items, variants: variants
                ))
            } catch let error as PopupSpecError {
                throw Invalid(error.description)
            }
        case "popup":
            return .popup(pid: try pid(), PopupOffer(offerKey: try string("offerKey"), spec: try spec(o["spec"])))
        case "helperLine":
            guard let line = o["line"] else { throw Invalid("needs line") }
            return .helperLine(try JSONEncoder().encode(line))
        default:
            throw Invalid("unknown kind \(kind)")
        }
    }
}

/// What the user accepted from an action line or pop-up: what the host sends the helper as
/// `offerAccept` (Fable plan, section 2, "Hand-off to the executor") and reports on the debug
/// socket. Not yet in `helper/src/protocol.ts`.
public struct OfferAccept: Codable, Equatable, Sendable {
    public static let type = "offerAccept"

    public var offerId: String
    public var actionId: String
    /// Choices the user made before accepting: the highlighted row of a choices block (by block
    /// id, or `variants` for an action line's picker), as a zero-based index.
    public var overrides: [String: Int]
    public var at: Int64

    public init(offerId: String, actionId: String, overrides: [String: Int], at: Int64) {
        self.offerId = offerId
        self.actionId = actionId
        self.overrides = overrides
        self.at = at
    }

    enum CodingKeys: String, CodingKey { case type, v, offerId, actionId, overrides, at }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard try c.decode(String.self, forKey: .type) == Self.type else { throw SurfaceInjection.Invalid("not offerAccept") }
        offerId = try c.decode(String.self, forKey: .offerId)
        actionId = try c.decode(String.self, forKey: .actionId)
        overrides = try c.decode([String: Int].self, forKey: .overrides)
        at = try c.decode(Int64.self, forKey: .at)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.type, forKey: .type)
        try c.encode(1, forKey: .v)
        try c.encode(offerId, forKey: .offerId)
        try c.encode(actionId, forKey: .actionId)
        try c.encode(overrides, forKey: .overrides)
        try c.encode(at, forKey: .at)
    }

    /// Builds the message for a claim on an action line or pop-up. Nil for text claims.
    public static func from(_ claim: Claim, at: Int64) -> OfferAccept? {
        guard let actionID = claim.choice.actionID else { return nil }
        var overrides: [String: Int] = [:]
        switch claim.offer.kind {
        case .popup(let popup):
            if let row = claim.choice.row {
                let visible = claim.choice.revealed.map { popup.spec.applyingReveal(of: $0) } ?? popup.spec
                let id = visible.blocks.first { if case .choices = $0.content { return true } else { return false } }?.id
                overrides[id ?? "choices"] = row
            }
            return OfferAccept(offerId: popup.offerKey, actionId: actionID, overrides: overrides, at: at)
        case .action(let line):
            if let row = claim.choice.row { overrides["variants"] = row }
            return OfferAccept(offerId: line.offerKey, actionId: actionID, overrides: overrides, at: at)
        case .ghost, .fill:
            return nil
        }
    }
}
