import CoreGraphics

/// Where the "Drag Caret into the list above" panel sits inside System Settings' window, the way T3 Code places its
/// own (src/permissions/MacSettingsWindow.ts in its app bundle, read 2026-10-09): centred in the content column right
/// of the sidebar, near the window's bottom edge. All rectangles are global, top-left origin (CGWindowList's space).
public enum SettingsDragPanelPlacement {
    /// System Settings' sidebar width, which the panel stays clear of.
    public static let sidebar: CGFloat = 216
    public static let maxWidth: CGFloat = 560
    public static let height: CGFloat = 140
    /// Gap between the panel and the window's bottom edge.
    public static let bottomMargin: CGFloat = 16
    /// The panel leaves this much of the content column free, split between its sides.
    public static let columnInset: CGFloat = 32
    /// A System Settings window smaller than this is a sheet or a closing animation, not the pane.
    public static let minimumSettings = CGSize(width: 500, height: 350)

    public struct Window: Equatable, Sendable {
        public var ownerPid: Int32
        public var layer: Int
        public var bounds: CGRect
        public var onScreen: Bool
        /// The owning process's name (`kCGWindowOwnerName`), which `somethingAsks` matches.
        public var ownerName: String
        /// `kCGWindowAlpha`: a window listed on screen at 0 shows nothing.
        public var alpha: Double

        public init(ownerPid: Int32, layer: Int, bounds: CGRect, onScreen: Bool = true, ownerName: String = "", alpha: Double = 1) {
            self.ownerPid = ownerPid
            self.layer = layer
            self.bounds = bounds
            self.onScreen = onScreen
            self.ownerName = ownerName
            self.alpha = alpha
        }
    }

    /// System Settings' main window among `windows`: on screen, layer 0, owned by `settingsPid`, at least
    /// `minimumSettings`, the largest if several.
    public static func settingsWindow(in windows: [Window], settingsPid: Int32) -> CGRect? {
        windows.filter { $0.onScreen && $0.layer == 0 && $0.ownerPid == settingsPid
            && $0.bounds.width >= minimumSettings.width && $0.bounds.height >= minimumSettings.height }
            .max { $0.bounds.width * $0.bounds.height < $1.bounds.width * $1.bounds.height }?.bounds
    }

    /// The panel's frame for a System Settings window at `settings`.
    public static func frame(settings: CGRect) -> CGRect {
        let column = settings.width - sidebar
        let width = max(0, min(maxWidth, column - columnInset))
        let x = settings.minX + sidebar + (column - width) / 2
        let y = settings.minY + settings.height - height - bottomMargin
        return CGRect(x: x, y: y, width: width, height: height)
    }

    /// Processes whose windows ask the person something over System Settings: the password and Touch ID dialogs.
    /// macOS's Accessibility alert (universalAccessAuthWarn) is not one: it closes before the pane opens, yet its
    /// process keeps a window listed on screen over it, which hid the panel for the whole visit (after-run f85de72).
    public static let askers: Set<String> = ["SecurityAgent", "coreautha"]
    /// A System Settings window smaller than this over the pane is a menu or a tooltip, which the panel may cover.
    public static let minimumSheet = CGSize(width: 200, height: 100)

    /// Whether something that asks the person sits over System Settings' window at `settings`: a sheet of System
    /// Settings' own, such as macOS 26's "Privacy & Security is trying to modify your system settings" after a drop, or
    /// a password dialog. The panel steps aside meanwhile: at status-bar level it covered that sheet's Cancel button
    /// (PX1 after-run at 732b115, shots/015-auth-drop.png).
    public static func somethingAsks(in windows: [Window], settingsPid: Int32, settings: CGRect) -> Bool {
        windows.contains { w in
            guard w.onScreen, w.alpha > 0, w.bounds != settings, w.bounds.intersects(settings) else { return false }
            if askers.contains(w.ownerName) { return true }
            return w.ownerPid == settingsPid && w.bounds.width >= minimumSheet.width && w.bounds.height >= minimumSheet.height
        }
    }
}
