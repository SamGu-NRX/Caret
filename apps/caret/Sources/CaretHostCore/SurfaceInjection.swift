import CaretScreenCore
import Foundation

/// An offer handed to the host through the debug socket's `inject` command, for tests and
/// screenshots only: the socket accepts it when the host runs with `CARET_TEST_HOOKS=1`. Real
/// offers arrive from the helper as `alternatives`, `action` and `popup` messages (`HelperOffer`).
/// An offer injected by kind is the host's own (`OfferSource.debug`): its claims are never
/// reported to the helper. A `helperLine` is the helper's, as if it came over the socket.
///
/// ```
/// {"kind":"alternatives","pid":123,"candidates":["…","…"],"quoted":false}
/// {"kind":"action","pid":123,"offerKey":"k","app":"Calendar","endState":{"text":"…","ref":{…}},
///  "actions":[{"id":"add","label":"Add","key":"tab"}],"variants":<PopupSpec>?}
/// {"kind":"popup","pid":123,"offerKey":"k","spec":<PopupSpec>}
/// {"kind":"helperLine","line":<one helper protocol message>}
/// ```
public enum SurfaceInjection: Equatable, Sendable {
    /// `quoted`: the top value is quoted from a source on screen, so it carries the uneven
    /// underline while collapsed. Model-written alternatives show the faint text alone.
    case alternatives(pid: Int32, candidates: [String], quoted: Bool)
    case action(pid: Int32, ActionLine)
    case popup(pid: Int32, PopupOffer)
    /// A raw helper message, delivered as if the helper had sent it: it takes the helper socket's
    /// route, so an injected `action` or `popup` is a helper offer whose Tab sends `offerAccept`.
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
            var quoted = false
            if case .bool(let q)? = o["quoted"] { quoted = q }
            return .alternatives(pid: try pid(), candidates: candidates, quoted: quoted)
        case "action":
            guard let endState = o["endState"], let rawActions = o["actions"] else {
                throw Invalid("needs endState and actions")
            }
            do {
                let value = try PopupSpec.parseValue(endState, path: "endState")
                // The bar follows the rules of a pop-up's actions block, as the helper's does.
                let actions = try PopupSpec.parseActionBar(rawActions, path: "actions")
                let variants = try o["variants"].map(spec)
                return .action(pid: try pid(), ActionLine(
                    offerKey: try string("offerKey"), app: try string("app"), endState: value,
                    actions: actions, variants: variants
                ))
            } catch let error as PopupSpecError {
                throw Invalid(error.description)
            }
        case "popup":
            var sourceApps: [String]?
            if let raw = o["sourceApps"] {
                guard case .array(let items) = raw else { throw Invalid("sourceApps must be an array of app names") }
                let apps = items.compactMap { if case .string(let s) = $0 { return s } else { return nil } }
                guard !apps.isEmpty, apps.count == items.count, apps.allSatisfy({ !$0.isEmpty }), Set(apps).count == apps.count else {
                    throw Invalid("sourceApps holds one or more distinct, non-empty app names")
                }
                sourceApps = apps
            }
            return .popup(pid: try pid(), PopupOffer(offerKey: try string("offerKey"), spec: try spec(o["spec"]), sourceApps: sourceApps))
        case "helperLine":
            guard let line = o["line"] else { throw Invalid("needs line") }
            return .helperLine(try JSONEncoder().encode(line))
        default:
            throw Invalid("unknown kind \(kind)")
        }
    }
}

/// `offerAccept` is the screen track's type (CaretScreenCore, mirroring helper/src/protocol.ts); the
/// host only builds it from a claim.
extension OfferAccept {
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
