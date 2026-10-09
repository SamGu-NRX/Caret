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

        public init(ownerPid: Int32, layer: Int, bounds: CGRect, onScreen: Bool = true) {
            self.ownerPid = ownerPid
            self.layer = layer
            self.bounds = bounds
            self.onScreen = onScreen
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
}
