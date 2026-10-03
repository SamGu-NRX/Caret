import SwiftUI

/// Where named views landed in the last render, for tests that check a window's layout (a footer
/// inside the window, a card that fits). Only tests set one; without it `probed` draws nothing
/// and records nothing.
///
/// The frames are written from a GeometryReader's content closure, which runs during layout in
/// `ImageRenderer` as well as on screen. Preference callbacks would be the usual route, but an
/// off-screen render has no update cycle to deliver them.
final class LayoutProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [String: CGRect] = [:]

    /// The coordinate space a probed window names at its root.
    static let space = "probe-window"

    func record(_ name: String, _ frame: CGRect) {
        lock.lock()
        recorded[name] = frame
        lock.unlock()
    }

    func frame(_ name: String) -> CGRect? {
        lock.lock()
        defer { lock.unlock() }
        return recorded[name]
    }
}

private struct LayoutProbeKey: EnvironmentKey {
    static let defaultValue: LayoutProbe? = nil
}

extension EnvironmentValues {
    var layoutProbe: LayoutProbe? {
        get { self[LayoutProbeKey.self] }
        set { self[LayoutProbeKey.self] = newValue }
    }
}

private struct Probed: ViewModifier {
    var name: String
    @Environment(\.layoutProbe) private var probe

    func body(content: Content) -> some View {
        if let probe {
            content.background(GeometryReader { g in
                let _ = probe.record(name, g.frame(in: .named(LayoutProbe.space)))
                Color.clear
            })
        } else {
            content
        }
    }
}

extension View {
    /// Records this view's frame, in the window's coordinates, when a test set a `LayoutProbe`.
    func probed(_ name: String) -> some View { modifier(Probed(name: name)) }
}
