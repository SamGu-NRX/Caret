import CaretScreenCore
import Foundation

// The browser in the host (H5, from W2): "Not on this site", a per-site off switch the user keeps in
// What Caret knows, and "Caret can't see this page yet", a quiet line when a Chrome page is in front
// and no page engine is connected for it.

/// A web origin as the helper's page engines name one (protocol.ts WebOrigin): scheme and host, with a
/// port only when it is not the scheme's default, and nothing after.
public enum SiteOrigin {
    /// The origin of `url`, or nil for anything but an http or https URL with a host.
    public static func of(_ url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = url.host(percentEncoded: false)?.lowercased(), !host.isEmpty, !host.contains(where: \.isWhitespace) else { return nil }
        let bracketed = host.contains(":") ? "[\(host)]" : host
        let defaultPort = scheme == "http" ? 80 : 443
        let port = url.port.flatMap { $0 == defaultPort ? nil : ":\($0)" } ?? ""
        return "\(scheme)://\(bracketed)\(port)"
    }

    /// Whether `s` is already an origin in that form (the settings file is the user's own, so it is checked on read).
    public static func isOrigin(_ s: String) -> Bool {
        guard let url = URL(string: s) else { return false }
        return of(url) == s
    }

    /// The origin as the knows window shows it: the host, with the port when there is one.
    public static func display(_ origin: String) -> String {
        guard let url = URL(string: origin), let host = url.host(percentEncoded: false) else { return origin }
        return url.port.map { "\(host):\($0)" } ?? host
    }
}

/// The host's `settings` line: B10's gate (CaretScreenCore's `GateSettings`) and, since H5, the sites
/// the user turned Caret off for. The CaretScreenCore mirror has no `sitesOff` key, so it is encoded
/// beside the gate's, as `HostHello.Message` does for capabilities.
public struct HostSettings: Encodable, Equatable, Sendable {
    public var gate: GateSettings
    /// Sorted origins, each once.
    public var sitesOff: [String]

    public init(_ settings: CaretSettings, at ms: Int64) {
        gate = GateSettings(settings, at: ms)
        sitesOff = settings.sitesOff
    }

    public init(gate: GateSettings, sitesOff: [String]) {
        self.gate = gate
        self.sitesOff = sitesOff
    }

    /// Everything the helper acts on is the same; only the stamp may differ.
    public func same(as other: HostSettings) -> Bool {
        gate.sameGate(as: other.gate) && sitesOff == other.sitesOff
    }

    enum CodingKeys: String, CodingKey { case sitesOff }

    public func encode(to encoder: Encoder) throws {
        try gate.encode(to: encoder)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(sitesOff, forKey: .sitesOff)
    }
}

/// When to say "Caret can't see this page yet" (W2's `pageEngine` message), and when to stop.
///
/// The helper says `missing` for a Chromium browser that is in front, that the user typed in since it
/// came to the front, and that has no Caret page engine connected; it says `connected` once one says
/// hello. The line is for Chrome only, because its one next step is Add to Chrome (H4's installer),
/// and it shows at most once per browser process per host session: it is information, not a nag. It
/// claims no key. It goes when an engine connects, when the browser leaves the front, when the user
/// clicks Add to Chrome, after `lifetime`, or when Caret is paused or loses its helper.
///
/// Decides only; `HostRuntime` draws. Main thread only.
public final class PageSight {
    public struct Line: Equatable, Sendable {
        public var browserPID: Int32
        public var browserName: String
    }

    public static let text = "Caret can't see this page yet."
    public static let action = "Add to Chrome…"
    /// The line stays this long. Assumed, not measured: long enough to read one sentence and reach
    /// for the button, short enough not to sit over the page. The slip's error lifetime is 6 s.
    public static let lifetime: TimeInterval = 8

    /// Browsers whose next step is Add to Chrome: Google Chrome's channels and Chrome for Testing.
    public static func isChrome(bundleID: String) -> Bool {
        let id = bundleID.lowercased()
        return id == "com.google.chrome" || id.hasPrefix("com.google.chrome.")
    }

    public private(set) var shown: Line?
    /// Browser processes the line was shown for this session.
    public private(set) var asked: Set<Int32> = []
    /// Browsers the helper says it cannot see, until it says otherwise.
    public private(set) var missing: [Int32: Line] = [:]

    private let clock: SurfaceClock
    private var timer: SurfaceTimer?
    public var onChange: (Line?) -> Void = { _ in }

    public init(clock: SurfaceClock) { self.clock = clock }

    /// The helper's word on one browser. `frontmostPID`: NSWorkspace's front app now; `paused`: Caret is paused.
    public func receive(_ m: PageEngineState, frontmostPID: Int32?, paused: Bool) {
        let pid = Int32(truncatingIfNeeded: m.browser.pid)
        switch m.state {
        case .connected:
            missing[pid] = nil
            if shown?.browserPID == pid { hide() }
        case .missing:
            guard Self.isChrome(bundleID: m.browser.bundleId) else { return }
            let line = Line(browserPID: pid, browserName: m.browser.name)
            missing[pid] = line
            show(line, frontmostPID: frontmostPID, paused: paused)
        }
    }

    /// Another app came to the front: the line goes with its browser, and comes up for a browser
    /// the helper said it cannot see, if it was not shown for that one yet.
    public func frontmostChanged(_ pid: Int32?, paused: Bool) {
        if let shown, shown.browserPID != pid { hide() }
        if let pid, let line = missing[pid] { show(line, frontmostPID: pid, paused: paused) }
    }

    /// The user clicked Add to Chrome. The installer runs; the line has done its work.
    public func addToChromeChosen() { hide() }

    /// Caret was paused: it says nothing.
    public func paused() { hide() }

    /// The helper went away: what it said about browsers no longer holds.
    public func helperGone() {
        missing = [:]
        hide()
    }

    private func show(_ line: Line, frontmostPID: Int32?, paused: Bool) {
        guard !paused, frontmostPID == line.browserPID, !asked.contains(line.browserPID) else { return }
        asked.insert(line.browserPID)
        shown = line
        timer?.cancel()
        timer = clock.schedule(after: Self.lifetime, repeats: false) { [weak self] in self?.hide() }
        onChange(line)
    }

    private func hide() {
        timer?.cancel()
        timer = nil
        guard shown != nil else { return }
        shown = nil
        onChange(nil)
    }

    /// What the debug socket's `state` shows.
    public struct DebugInfo: Codable, Equatable, Sendable {
        public var shown: String?
        public var asked: [Int32]
        public var missing: [Int32]
    }

    public var debugInfo: DebugInfo {
        DebugInfo(shown: shown?.browserName, asked: asked.sorted(), missing: missing.keys.sorted())
    }
}

/// The Sites tab of What Caret knows: the sites Caret stays off, one switch per site. Pure, so the
/// words and the parsing are tested without a window.
public enum SitesPage {
    public static let intro = "Sites where Caret stays out. Caret for Chrome reads nothing and does nothing on them."
    public static let empty = "Caret works on every site."
    public static let offHead = "Caret stays out of"
    public static let hereLabel = "The page you were on"
    public static let addTitle = "Add a site"
    public static let placeholder = "jobs.example.com"
    public static let turnOff = "Not on this site"
    public static let turnOn = "Turn back on"
    public static let notAnAddress = "That isn't a web address. Type a site such as jobs.example.com."

    /// What was typed, as an origin: a whole URL, or a host on its own, which is taken as https.
    /// Nil for anything else: a word with no dot, a path, a file.
    public static func origin(typed: String) -> String? {
        let t = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, !t.contains(where: \.isWhitespace) else { return nil }
        let withScheme = t.contains("://") ? t : "https://\(t)"
        guard let url = URL(string: withScheme), let origin = SiteOrigin.of(url), let host = url.host(percentEncoded: false) else { return nil }
        // A host on its own needs a dot (a domain or an IPv4 address) or is localhost.
        guard host.contains(".") || host.contains(":") || host == "localhost" else { return nil }
        return origin
    }

    /// What the tab shows: the sites off (from the settings), the page the user was on when the
    /// window opened, and the field to add a site with what it said last.
    public struct State: Codable, Equatable, Sendable {
        public var off: [String] = []
        /// The origin of the Chrome page in front when the window opened; nil when there was none.
        public var here: String?
        public var draft = ""
        public var problem: String?
        public init(off: [String] = [], here: String? = nil, draft: String = "", problem: String? = nil) {
            self.off = off
            self.here = here
            self.draft = draft
            self.problem = problem
        }
    }

    /// The suggestion row: the page the user was on, unless Caret is off there already.
    public static func here(_ origin: String?, off: [String]) -> String? {
        guard let origin, !off.contains(origin) else { return nil }
        return origin
    }
}
