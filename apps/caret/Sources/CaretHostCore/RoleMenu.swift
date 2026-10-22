/// The menu bar's Help With items while onboarding holds the cloud roles (`SettingsStore.rolesCap`): until the person
/// sends the first look or keeps everything on the Mac, a role outside the cap can't be turned on from the menu. It
/// says so, and choosing it opens setup where that choice is made, rather than doing nothing.
public enum RoleMenu {
    public static let finishSetup = "Finish setup to turn this on"

    public enum Choice: Equatable, Sendable {
        /// Turn the role on or off, as always.
        case toggle
        /// Open onboarding at the step that decides it.
        case finishSetup
    }

    /// What choosing `role` does, given the roles cap (nil when nothing is held).
    public static func choice(_ role: CaretRole, cap: Set<CaretRole>?) -> Choice {
        guard let cap, !cap.contains(role) else { return .toggle }
        return .finishSetup
    }

    /// The line under the item: `finishSetup` for a held role, else none.
    public static func note(_ role: CaretRole, cap: Set<CaretRole>?) -> String? {
        choice(role, cap: cap) == .finishSetup ? finishSetup : nil
    }
}
