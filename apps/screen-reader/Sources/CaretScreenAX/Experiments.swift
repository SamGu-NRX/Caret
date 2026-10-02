// Experiment harnesses from the deep plan's section 11. They write measurements, not screen
// content, except for the marker strings the fixtures themselves put on screen.
import ApplicationServices
import CaretScreenCore
import Foundation

/// E1: logs every Accessibility notification with the time its callback ran. When the notified
/// element's value or title holds a fixture marker ("T<epoch ms><action><n>"), the line carries the
/// marker, so the report can compute delivery latency and coverage per action.
public final class NotificationRecorder: @unchecked Sendable {
    private let handle: FileHandle
    private let queue = DispatchQueue(label: "caret.screen.e1")
    private let marker = try! NSRegularExpression(pattern: "T(\\d{13})([a-z]+)(\\d+)")
    public private(set) var count = 0

    public init(handle: FileHandle) { self.handle = handle }

    /// The marker with the latest timestamp not after `before` among these elements' value, title and description.
    private func newestMarker(in els: [AXUIElement], before: Double) -> (String, String, Double)? {
        var best: (String, String, Double)?
        for e in els {
            AXUIElementSetMessagingTimeout(e, AX.elementTimeout)
            for case let s? in [AX.string(e, kAXValueAttribute), AX.string(e, kAXTitleAttribute), AX.string(e, kAXDescriptionAttribute)] {
                let ns = s as NSString
                for m in marker.matches(in: s, range: NSRange(location: 0, length: min(ns.length, 4000))) {
                    let at = Double(ns.substring(with: m.range(at: 1))) ?? 0
                    if at <= before + 5, best == nil || at > best!.2 {
                        best = (ns.substring(with: m.range), ns.substring(with: m.range(at: 2)), at)
                    }
                }
            }
        }
        return best
    }

    public func tap(_ t: Date, _ pid: pid_t, _ name: String, _ el: AXRef) {
        let tMs = t.timeIntervalSince1970 * 1000
        queue.async {
            AXUIElementSetMessagingTimeout(el.el, AX.elementTimeout)
            var rec: [String: Any] = ["t": (tMs * 10).rounded() / 10, "pid": Int(pid), "n": name]
            if let role = AX.string(el.el, kAXRoleAttribute) { rec["role"] = role }
            // The newest marker in the element or up to three levels below it. A web area's title
            // carries the last title marker, so the element's own text alone would credit every
            // container notification to the title change.
            let mine = self.newestMarker(in: [el.el], before: tMs)
            var below: [AXUIElement] = []
            var level = AX.elements(el.el, kAXChildrenAttribute) ?? []
            for _ in 0..<3 where !level.isEmpty && below.count < 150 {
                below += level.prefix(150 - below.count)
                level = level.prefix(40).flatMap { AX.elements($0, kAXChildrenAttribute) ?? [] }
            }
            let deep = self.newestMarker(in: below, before: tMs)
            let pick = [mine.map { ($0, "self") }, deep.map { ($0, "descendant") }].compactMap { $0 }.max { $0.0.2 < $1.0.2 }
            if let ((marker, action, at), depth) = pick {
                rec["marker"] = marker
                rec["action"] = action
                rec["latencyMs"] = ((tMs - at) * 10).rounded() / 10
                rec["markerIn"] = depth
            }
            if let d = try? JSONSerialization.data(withJSONObject: rec, options: [.sortedKeys]) {
                self.handle.write(d + Data([0x0A]))
                self.count += 1
            }
        }
    }
}

/// E8: walks the matching windows of the given apps many times and measures how often the same live
/// element keeps the same key. Identity across walks is CFEqual on the element, which is what the key
/// is meant to stand in for.
public enum KeyStability {
    public struct WindowReport: Codable, Sendable {
        public var app: String
        public var window: String
        public var runs: Int
        public var meanNodes: Double
        public var meanWalkMs: Double
        /// Kept elements seen in the first walk.
        public var tracked: Int
        /// Of those, present in every walk.
        public var presentInAll: Int
        /// Of those present in every walk, with the same key every time.
        public var stableKey: Int
        /// Keys from the first walk that appear in every walk, whatever element carries them.
        public var keysInAll: Int
        public var keysFirst: Int
        public var drift: [Drift]
    }

    public struct Drift: Codable, Sendable {
        public var role: String
        public var keys: [String]
        public var cause: String
    }

    @MainActor
    /// `warmup` walks run first and are not counted, so a page still loading does not become the baseline.
    public static func run(workers: [AppWorker], titleMatch: NSRegularExpression?, runs: Int, interval: TimeInterval, warmup: Int = 3) -> [WindowReport] {
        struct Acc {
            var app: String
            var title: String
            var firstKeys: Set<String> = []
            var keysInAll: Set<String> = []
            var first: [AXRef: (role: String, key: String)] = [:]
            var seen: [AXRef: [String]] = [:]
            var nodes = 0
            var ms = 0.0
            var runs = 0
        }
        // Keyed by the live window, since a page can change its window's title between walks.
        var acc: [AXRef: Acc] = [:]
        let filter: (String) -> Bool = { title in
            guard let re = titleMatch else { return true }
            return re.firstMatch(in: title, range: NSRange(location: 0, length: (title as NSString).length)) != nil
        }
        for _ in 0..<warmup {
            for w in workers { _ = w.walkForExperiment(titleFilter: filter) }
            Thread.sleep(forTimeInterval: interval)
        }
        for i in 0..<runs {
            for w in workers {
                for r in w.walkForExperiment(titleFilter: filter) {
                    let id = r.window
                    var a = acc[id] ?? Acc(app: w.app.name, title: r.windowTitle)
                    var keys = Set<String>()
                    var roleByKey: [String: String] = [:]
                    for n in r.nodes { roleByKey[n.key] = n.role }
                    for (h, kc) in r.contexts {
                        let el = r.elements[h]
                        keys.insert(kc.key)
                        if i == 0 { a.first[el] = (roleByKey[kc.key] ?? kc.role, kc.key) }
                        a.seen[el, default: []].append(kc.key)
                    }
                    if i == 0 { a.firstKeys = keys; a.keysInAll = keys } else { a.keysInAll.formIntersection(keys) }
                    a.nodes += r.nodes.count
                    a.ms += r.ms
                    a.runs += 1
                    acc[id] = a
                }
            }
            if i + 1 < runs { Thread.sleep(forTimeInterval: interval) }
        }
        return acc.values.sorted { ($0.app, $0.title) < ($1.app, $1.title) }.map { a in
            var present = 0, stable = 0
            var drift: [Drift] = []
            for (el, f) in a.first {
                let ks = a.seen[el] ?? []
                guard ks.count == a.runs else { continue }
                present += 1
                let distinct = Array(Set(ks)).sorted()
                if distinct.count == 1 { stable += 1; continue }
                if drift.count < 60 { drift.append(Drift(role: f.role, keys: distinct, cause: cause(distinct))) }
            }
            return WindowReport(app: a.app, window: a.title, runs: a.runs,
                                meanNodes: Double(a.nodes) / Double(max(1, a.runs)), meanWalkMs: a.ms / Double(max(1, a.runs)),
                                tracked: a.first.count, presentInAll: present, stableKey: stable,
                                keysInAll: a.keysInAll.count, keysFirst: a.firstKeys.count, drift: drift)
        }
    }

    /// Which part of the key moved between walks: the label, the ordinal, or the ancestor chain.
    static func cause(_ keys: [String]) -> String {
        guard keys.count >= 2 else { return "none" }
        func split(_ k: String) -> (chain: String, seg: String, ord: String) {
            let parts = k.components(separatedBy: "/")
            let last = parts.last ?? ""
            let segOrd = last.components(separatedBy: "~")
            return (parts.dropLast().joined(separator: "/"), segOrd.first ?? "", segOrd.count > 1 ? segOrd[1] : "")
        }
        let a = split(keys[0]), b = split(keys[1])
        if a.chain != b.chain { return "ancestors" }
        if a.seg != b.seg { return "label" }
        if a.ord != b.ord { return "ordinal" }
        return "other"
    }
}
