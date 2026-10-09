public enum Standing: Equatable, Sendable {
    case offerEachTime
}

/// The visible offer is the consent for any state-changing action.
/// A ledger of accepts and undos plugs in here later.
public protocol EarnedTrust {
    func standing(action: String, bundleID: String) -> Standing
}

public struct NoEarnedTrust: EarnedTrust, Sendable {
    public init() {}

    public func standing(action: String, bundleID: String) -> Standing {
        .offerEachTime
    }
}
