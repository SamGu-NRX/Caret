import AppKit
import CaretHostCore
import CaretScreenCore
import SwiftUI

/// "Caret can't see this page yet" (`PageSight`): a quiet slip with the figure still, and under it,
/// in the same glass, what would let Caret see the page and the button that does it. It is the one
/// slip that takes a click and no key: every key in a browser belongs to the page, and the next step
/// is an install the user starts, never one a stray Tab could.
struct PageSightView: View {
    var character: FigureCharacter
    var animated = true
    var onAdd: () -> Void = {}

    static let content = LineContent(figure: .still, text: PageSight.text, emphasis: .plain)
    static let why = "Caret for Chrome lets it read pages."

    var body: some View {
        LineView(content: Self.content, character: character, animated: animated, under: AnyView(row), underInteractive: true)
    }

    private var row: some View {
        VStack(alignment: .leading, spacing: 0) {
            Rectangle().fill(Color(token: Tokens.rule)).frame(height: 1)
            HStack(spacing: 12) {
                Text(Self.why)
                    .font(Tokens.Font.chromeSmall)
                    .foregroundStyle(Color(token: Tokens.ink2))
                    .fixedSize()
                Spacer(minLength: 0)
                Button(PageSight.action, action: onAdd)
                    .buttonStyle(WindowButtonStyle(kind: .key, small: true))
                    .accessibilityHint("Installs Caret's browser connection and opens the Extensions page.")
            }
            .padding(.leading, LineView.textIndent(compact: false))
            .padding(.trailing, Tokens.Shape.slipTrailing)
            .padding(.vertical, 6)
        }
    }
}

/// Draws `PageSight`'s line at the top right of the browser's front window, under its toolbar, and
/// follows the front app. Main thread only.
@MainActor
final class PageSightCoordinator {
    let sight: PageSight
    private let panel = HostedPanel(radius: Tokens.Shape.slipRadius, interactive: true)
    private var observer: NSObjectProtocol?
    /// Whether Caret is paused now.
    var paused: () -> Bool = { false }
    /// Add to Chrome (H4's `ChromeBridgeInstaller`, run by the app shell).
    var onAddToChrome: () -> Void = {}
    /// Off screen in a headless run: decided and reported, never drawn.
    let draws: Bool

    /// Below a Chrome window's tab strip and toolbar, and in from its right edge. Assumed, not
    /// measured: Chrome's default tab strip and toolbar together are under 88 pt tall.
    static let inset = CGSize(width: 16, height: 88)

    init(clock: SurfaceClock = RunLoopClock(), draws: Bool) {
        sight = PageSight(clock: clock)
        self.draws = draws
        sight.onChange = { [weak self] line in self?.redraw(line) }
        observer = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] note in
            let pid = (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.processIdentifier
            MainActor.assumeIsolated { self?.frontmostChanged(pid) }
        }
    }

    func receive(_ m: PageEngineState) {
        sight.receive(m, frontmostPID: NSWorkspace.shared.frontmostApplication?.processIdentifier, paused: paused())
    }

    func frontmostChanged(_ pid: Int32?) { sight.frontmostChanged(pid, paused: paused()) }

    func shutdown() {
        if let observer { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
        observer = nil
        sight.helperGone()
        panel.exit(duration: 0)
    }

    /// Draws the line, or takes it down. `HostRuntime` calls it from its own `onChange`, which
    /// also reports the change to the debug state.
    func redraw(_ line: PageSight.Line?) {
        guard draws else { return }
        guard let line else { return panel.exit(duration: 0.22) }
        // The browser's front window, as the window server lists it (top-left global points).
        guard let window = Visibility.windows().first(where: { $0.pid == line.browserPID && $0.layer == 0 }) else { return }
        let view = PageSightView(character: FigureSettings.shared.character, onAdd: { [weak self] in
            self?.sight.addToChromeChosen()
            self?.onAddToChrome()
        })
        let topRight = Screen.cocoa(CGRect(x: window.bounds.maxX - Self.inset.width, y: window.bounds.minY + Self.inset.height, width: 0, height: 0))
        panel.pin(HostedPanel.Anchor(corner: .topRight, point: NSPoint(x: topRight.minX, y: topRight.maxY)))
        panel.setContent(view)
        panel.text = PageSight.text + " " + PageSight.action
        panel.enter()
        // A slip takes no focus, so its words are announced (`SlipAnnouncer`), as every slip's are.
        SlipAnnouncer.post("\(PageSight.text) \(PageSightView.why)")
    }

    /// Whether the line is on screen, for the debug socket.
    var onScreen: Bool { panel.isVisible }
}
