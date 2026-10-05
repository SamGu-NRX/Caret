import CaretScreenCore
import CoreGraphics
import Foundation

/// H10: forms in a browser's pages, which the host cannot see. Chrome shows Accessibility no web content and no
/// focused element while a page field has focus (evidence/host/h10/probe), so for a page the helper's page engine
/// says which field has focus and where (`PageField`), and the helper writes the field (`FillAllRequest.fieldKey`).
public enum PageWindow {
    /// A page engine's window id, `page:<engine>:<tab>` (helper/src/engines/windows.ts); never a reader's `<pid>-<n>`.
    public static func isPage(_ windowID: String) -> Bool { windowID.hasPrefix("page:") }
}

/// The browsers Caret's page engine can run in: helper/src/engines/presence.ts `CHROMIUM_BROWSERS`, the same list.
/// A prefix match, so a channel suffix (".beta", ".canary") counts.
public enum ChromiumBrowsers {
    static let ids = [
        "com.google.Chrome", "com.google.chrome.for.testing", "org.chromium.Chromium", "net.imput.helium", "com.brave.Browser",
        "com.microsoft.edgemac", "com.vivaldi.Vivaldi", "company.thebrowser.Browser", "com.operasoftware.Opera",
    ].map { $0.lowercased() }

    public static func contains(_ bundleID: String) -> Bool {
        let id = bundleID.lowercased()
        return ids.contains { id == $0 || id.hasPrefix($0 + ".") }
    }
}

/// The process a fill proposal's form belongs to, or why the host will not offer it.
public enum FormProcess: Equatable, Sendable {
    case process(Int32)
    /// A reason for the log and the debug state (`FillMachine.Status.lastSkip`, as "refused.<reason>").
    case refused(String)
}

extension FillSelection {
    /// The form's process, from the proposal's own `pid`, checked against its window id.
    ///
    /// A reader window id (`<pid>-<n>`) names its process, and the proposal must name the same one. A page window id
    /// names none: before H10 the host parsed a pid out of every id, so each page proposal was dropped as
    /// `notAllowed` (Q2's VM run). The helper sets a page proposal's `pid` to the browser that launched the bridge,
    /// which the bridge verified as its parent. The host takes it only while that pid runs an app whose bundle id is
    /// the proposal's and a Chromium browser, so a proposal cannot point a fill at another app by naming its pid.
    public static func formProcess(_ proposal: FillProposal, runningBundleID: (Int32) -> String?) -> FormProcess {
        guard let pid = Int32(exactly: proposal.pid), pid > 0 else { return .refused("noProcess") }
        if PageWindow.isPage(proposal.windowId) {
            guard let running = runningBundleID(pid) else { return .refused("pageAppGone") }
            guard running == proposal.bundleId else { return .refused("pageAppMismatch") }
            guard ChromiumBrowsers.contains(running) else { return .refused("pageNotBrowser") }
            return .process(pid)
        }
        guard let named = Self.pid(fromWindowID: proposal.windowId) else { return .refused("unknownWindowID") }
        return named == pid ? .process(pid) : .refused("pidMismatch")
    }
}

/// The page field the user is in, per browser process, as the helper last said (`PageField`). Main thread only.
public final class PageFocusBook {
    private var latest: [Int32: PageField] = [:]

    public init() {}

    /// Keeps the newer of this and the record held for the same browser: walks can answer out of order. Returns the
    /// browser's pid, for the caller to look again there.
    @discardableResult
    public func receive(_ field: PageField) -> Int32? {
        guard let pid = Int32(exactly: field.app.pid) else { return nil }
        if let held = latest[pid], held.at > field.at { return pid }
        latest[pid] = field
        return pid
    }

    /// The field with focus in that browser's front tab: nil when no control has focus there, or nothing was said.
    public func field(pid: Int32) -> PageField? {
        guard let f = latest[pid], f.key != nil else { return nil }
        return f
    }

    /// The browser's process went away.
    public func forget(pid: Int32) { latest[pid] = nil }
}

extension PageField {
    /// The field as the fill and surface machines read a focused field: its node key stands for the element, the page
    /// window for the window. The value is not sent, so an empty field reads "" and any other reads as not empty.
    public var identity: TargetIdentity? {
        guard let key, let pid = Int32(exactly: app.pid) else { return nil }
        return TargetIdentity(pid: pid, bundleID: app.bundleId, windowID: windowId, elementID: key, elementRevision: empty ? UTF16Text.digest("") : "page:nonempty")
    }

    public var rect: CGRect? { frame.map { CGRect(x: $0.x, y: $0.y, width: $0.width, height: $0.height) } }
}
