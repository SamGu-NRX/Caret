import Foundation

/// What a copy of Caret opened from Finder does about its login item (the launchd agent), decided from the agent's
/// status and whether onboarding has finished. Registering makes macOS post "Background Items Added", so it waits until
/// onboarding is over (or the browser step needs the bridge, which only the agent can vend): the person's first win
/// comes first (R7 dossier, technique 12). A login item switched off in System Settings is never registered again.
public enum LoginItemPlan: Equatable, Sendable {
    /// Already registered: start it and hand off.
    case kickstart
    /// Register it now and hand off.
    case register
    /// Run in this process; `deferred` says the registration is only waiting for onboarding to end.
    case runHere(reason: String, deferred: Bool)

    /// SMAppService's status, mirrored so the rule is tested without ServiceManagement.
    public enum Status: Equatable, Sendable { case notRegistered, enabled, requiresApproval, notFound, unknown }

    public static let deferredReason = "the login item is registered once onboarding is done"

    public static func decide(status: Status, onboarded: Bool) -> LoginItemPlan {
        switch status {
        case .enabled: return .kickstart
        case .requiresApproval:
            return .runHere(reason: "Caret's login item is turned off in System Settings › Login Items", deferred: false)
        case .notRegistered, .notFound:
            return onboarded ? .register : .runHere(reason: deferredReason, deferred: true)
        case .unknown: return .runHere(reason: "unknown login item status", deferred: false)
        }
    }
}
