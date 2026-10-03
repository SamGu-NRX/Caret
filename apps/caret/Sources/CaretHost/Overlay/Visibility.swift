import AppKit
import ApplicationServices
import CaretHostCore

/// The live inputs to `SurfaceGate`: the frontmost app, the app's focused field, and the window
/// server's on-screen windows.
@MainActor
enum Visibility {
    /// Nil when a surface for `target` may be drawn at `anchors` (global, top-left points).
    /// `requireFocus: false` is for a result toast, which reports on a field the form has already
    /// moved focus away from; it still needs the app in front and its anchor uncovered.
    static func hold(for target: TargetIdentity, anchors: [CGPoint], requireFocus: Bool = true) -> SurfaceGate.Hold? {
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
        // Cheapest test first: no Accessibility read for an app that is not in front.
        guard front == target.pid else { return .appNotFront }
        var focused = true
        // The focused field's frame, so a writing aid's window drawn around it is not a cover
        // (`SurfaceGate.ringsField`). Read only for the field the surface is for.
        var fieldFrame: CGRect?
        if requireFocus {
            let live = FieldReader.readFocused(pid: target.pid)
            focused = live?.field.identity.elementID == target.elementID && live?.field.identity.windowID == target.windowID
            if focused, let element = live?.element { fieldFrame = AXRead.frame(of: element) }
        }
        return SurfaceGate.check(
            targetPID: target.pid, frontmostPID: front, fieldIsFocused: focused, anchors: anchors,
            windows: windows(), ownPID: ProcessInfo.processInfo.processIdentifier,
            displays: NSScreen.screens.map { Screen.ax($0.frame) }, field: fieldFrame
        )
    }

    /// On-screen windows, front to back. Window-server only, so any thread may call it (the input
    /// pause reads it off the tap thread).
    nonisolated static func windows() -> [SurfaceGate.Window] {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            return []
        }
        return list.compactMap { info in
            guard let pid = info[kCGWindowOwnerPID as String] as? Int32,
                  let raw = info[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: raw as CFDictionary) else { return nil }
            return SurfaceGate.Window(
                pid: pid, bounds: bounds,
                layer: info[kCGWindowLayer as String] as? Int ?? 0,
                alpha: info[kCGWindowAlpha as String] as? Double ?? 1
            )
        }
    }
}

/// Rechecks a shown surface every half second and whenever another app activates, and calls
/// `onLost` once when the gate closes (the app went behind, another window covered the field,
/// focus moved). Half a second is assumed: fast enough that a surface over someone else's window
/// does not linger, and a window-list read costs about a millisecond.
@MainActor
final class VisibilityWatch {
    private var timer: Timer?
    private var observer: NSObjectProtocol?
    private var check: (() -> SurfaceGate.Hold?)?
    private var onLost: ((SurfaceGate.Hold) -> Void)?

    var isWatching: Bool { check != nil }

    func start(check: @escaping () -> SurfaceGate.Hold?, onLost: @escaping (SurfaceGate.Hold) -> Void) {
        stop()
        self.check = check
        self.onLost = onLost
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        observer = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        if let observer { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
        observer = nil
        check = nil
        onLost = nil
    }

    private func tick() {
        guard let check, let hold = check() else { return }
        let lost = onLost
        stop()
        lost?(hold)
    }
}
