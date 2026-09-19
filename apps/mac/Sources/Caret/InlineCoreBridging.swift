import Foundation
import CaretCore

/// Conversions between the app's inline types and the core's wire types.
///
/// The app keeps its own `InlineTarget` and `InlineOffer` so the key router
/// and offer store stay testable without a running bridge. These are the only
/// two places the two vocabularies meet.
extension InlineTarget {
    init(_ identity: TargetIdentity) {
        self.init(
            pid: identity.pid,
            bundleID: identity.bundleID,
            windowID: identity.windowID,
            elementID: identity.elementID,
            elementRevision: identity.elementRevision
        )
    }

    var identity: TargetIdentity {
        TargetIdentity(
            pid: pid,
            bundleID: bundleID,
            windowID: windowID,
            elementID: elementID,
            elementRevision: elementRevision
        )
    }
}

extension InlineOffer {
    init(_ offer: CaretCore.InlineOffer) {
        self.init(
            proposalID: offer.proposalID,
            revision: offer.revision,
            target: InlineTarget(offer.target),
            replaceStart: offer.replaceStart,
            replaceEnd: offer.replaceEnd,
            replacement: offer.replacement,
            originalDigest: offer.originalDigest,
            createdAt: offer.createdAt
        )
    }

    /// The shape `InsertionGuard.approve` expects.
    ///
    /// `InlineEdit` is decode-only in CaretCore, which owns it, so this goes
    /// through the same JSON the wire uses rather than reaching in to add a
    /// memberwise initializer to someone else's type. The encoding is the
    /// documented one, so a change to the wire keys fails here loudly.
    var coreEdit: InlineEdit? {
        InlineEditBuilder.make(
            proposalID: proposalID,
            target: target.identity,
            replaceStart: replaceStart,
            replaceEnd: replaceEnd,
            replacement: replacement,
            originalDigest: originalDigest
        )
    }
}

extension InlineCompletionRequest {
    /// The snapshot the core judges. Built by `FocusedTargetCapture`, not
    /// here: bounding and identity are the capture's job.
    var snapshot: InputSnapshot {
        InputSnapshot(
            revision: revision,
            capturedAt: Date(),
            target: target.identity,
            role: role,
            nearbyText: nearbyText,
            textOffset: textOffset,
            caret: caret,
            selection: TextSelection(start: selection.location, end: selection.location + selection.length),
            secure: secure,
            imeComposing: imeComposing,
            appExcluded: appExcluded,
            valueLength: valueLength
        )
    }
}

extension InsertionGuard.Rejection {
    /// What to tell the user, and what to log. Never carries field text.
    var shortReason: String {
        switch self {
        case .targetMoved: return "target_moved"
        case .fieldContentChanged: return "field_content_changed"
        case .replacedTextChanged: return "replaced_text_changed"
        case .selectionMoved: return "selection_moved"
        case .rangeOutsideValue: return "range_outside_value"
        case .rangeSplitsCharacter: return "range_splits_character"
        case .offerExpired: return "offer_expired"
        case .secureField: return "secure_field"
        }
    }
}


enum InlineEditBuilder {
    private struct Payload: Encodable {
        let proposal_id: String
        let target: TargetIdentity
        let replace_start: Int
        let replace_end: Int
        let replacement: String
        let original_digest: String
    }

    static func make(
        proposalID: String,
        target: TargetIdentity,
        replaceStart: Int,
        replaceEnd: Int,
        replacement: String,
        originalDigest: String
    ) -> InlineEdit? {
        let payload = Payload(
            proposal_id: proposalID,
            target: target,
            replace_start: replaceStart,
            replace_end: replaceEnd,
            replacement: replacement,
            original_digest: originalDigest
        )
        guard let data = try? JSONEncoder().encode(payload) else { return nil }
        return try? JSONDecoder().decode(InlineEdit.self, from: data)
    }
}
