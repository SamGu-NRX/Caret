import CaretScreenCore
import CoreGraphics
import Foundation

/// The perch: the figure at about 32 pt at the edge of the screen, reporting background work by
/// its state and by where its eyes point (plan section 3, "Reporting", and strongest call 3).
/// This file is the decision logic; `PerchController` draws it.
public enum Perch {
    /// What the perch shows.
    public enum Mood: String, Codable, Sendable, Equatable {
        /// A run is acting, or a watch is watching. Eyes on that window.
        case working
        /// A run is paused and waits for Continue. Eyes on its window, still.
        case waiting
        /// The helper handed work back, or a watched job asks for the user. Eyes on that window.
        case needsYou
        /// Finished; one gesture of relief, then the perch leaves.
        case done
        /// Failed: graphite, posture down, until the activity list has been opened.
        case error
    }

    /// How long a finished task keeps the perch. Assumed, not measured: long enough to see the
    /// gesture land from the corner of the eye, short enough that the perch is not idle on screen
    /// (`IDENTITY.md`: never idle on screen).
    public static let doneHold: TimeInterval = 6
    /// A failure stays until the list is opened, or this long. Assumed.
    public static let errorHold: TimeInterval = 10 * 60

    /// The task the perch reports on and how.
    public struct Subject: Equatable, Sendable, Codable {
        public var taskId: String
        public var mood: Mood
        /// The app the task acts in or watches, for the gaze and the input pause.
        public var pid: Int32?
        public var windowId: String?
        public var windowTitle: String?
        public var app: String?
        /// Rows in the list's Needs you section, including this one.
        public var needsYou: Int

        public init(taskId: String, mood: Mood, pid: Int32?, windowId: String?, windowTitle: String?, app: String?, needsYou: Int) {
            self.taskId = taskId
            self.mood = mood
            self.pid = pid
            self.windowId = windowId
            self.windowTitle = windowTitle
            self.app = app
            self.needsYou = needsYou
        }
    }

    /// The mood a task's state gives the perch, or nil when the task does not put the perch on
    /// screen. `ready` is a prepared offer at the caret, not work; `undone` was the user's choice.
    public static func mood(for state: TaskState) -> Mood? {
        switch state {
        case .preparing, .running: return .working
        case .paused: return .waiting
        case .needsYou: return .needsYou
        case .done: return .done
        case .failed: return .error
        case .ready, .undone: return nil
        }
    }

    /// The most recently changed task that puts the perch on screen, except that a task needing
    /// the user outranks everything else: it is the one state that stops until the user acts
    /// (plan section 3: "Only needs you may change the perch immediately"). Finished tasks count
    /// only within their hold. `acknowledgedAt` is when the activity list was last opened, in ms.
    public static func subject(_ records: [TaskRecord], now: Date, acknowledgedAt: Int64 = 0) -> Subject? {
        let nowMs = Int64(now.timeIntervalSince1970 * 1000)
        let candidates = records.compactMap { r -> (TaskRecord, Mood)? in
            guard let mood = mood(for: r.state) else { return nil }
            switch mood {
            case .done:
                guard nowMs - r.updatedAt < Int64(doneHold * 1000) else { return nil }
            case .error:
                guard r.updatedAt > acknowledgedAt, nowMs - r.updatedAt < Int64(errorHold * 1000) else { return nil }
            case .working, .waiting, .needsYou:
                break
            }
            return (r, mood)
        }
        let newest: ((TaskRecord, Mood), (TaskRecord, Mood)) -> Bool = {
            $0.0.updatedAt != $1.0.updatedAt ? $0.0.updatedAt > $1.0.updatedAt : $0.0.id < $1.0.id
        }
        let urgent = candidates.filter { $0.1 == .needsYou }.sorted(by: newest).first
        guard let pick = urgent ?? candidates.sorted(by: newest).first else { return nil }
        let (record, mood) = pick
        return Subject(
            taskId: record.id, mood: mood, pid: record.app.map { Int32(truncatingIfNeeded: $0.pid) },
            windowId: record.windowId, windowTitle: record.windowTitle, app: record.app?.name,
            needsYou: ActivityList.needsYouCount(records)
        )
    }

    /// When the perch must look again even if no message arrives: the moment a done or error
    /// hold runs out. Nil when nothing expires.
    public static func nextExpiry(_ records: [TaskRecord], now: Date, acknowledgedAt: Int64 = 0) -> Date? {
        let nowMs = Int64(now.timeIntervalSince1970 * 1000)
        let ends = records.compactMap { r -> Int64? in
            switch r.state {
            case .done: return r.updatedAt + Int64(doneHold * 1000)
            case .failed: return r.updatedAt > acknowledgedAt ? r.updatedAt + Int64(errorHold * 1000) : nil
            default: return nil
            }
        }.filter { $0 > nowMs }
        return ends.min().map { Date(timeIntervalSince1970: Double($0) / 1000) }
    }
}

// MARK: - Gaze

/// Where the eyes point. A vector of length at most 1 in screen space (x right, y down, the same
/// as Accessibility frames and the figure's viewBox); each character turns it into its own
/// glance. Zero means looking out at the user.
public enum PerchGaze {
    /// A window whose center is this close to the perch's center gets a straight look, since any
    /// direction would be noise. Assumed.
    public static let deadZone: CGFloat = 24

    /// Toward the center of `window`, from `perch` (both global, top-left origin). Zero when the
    /// window holds the perch itself or its center is within the dead zone.
    public static func toward(_ window: CGRect, from perch: CGPoint) -> CGVector {
        guard !window.isNull, !window.isEmpty, !window.contains(perch) else { return .zero }
        let dx = window.midX - perch.x, dy = window.midY - perch.y
        let length = (dx * dx + dy * dy).squareRoot()
        guard length > deadZone else { return .zero }
        return CGVector(dx: dx / length, dy: dy / length)
    }

    /// Without a known window: working looks up and out, the way the text-size figure looks
    /// away before it leaves (`IDENTITY.md`, Working); the other moods look at the user.
    public static func fallback(for mood: Perch.Mood) -> CGVector {
        mood == .working ? CGVector(dx: 0.7, dy: -0.7) : .zero
    }
}

// MARK: - Placement

/// Where on the screen the perch sits, and how it gives way to the focused field and the caret.
///
/// The perch obeys the surface gate's spirit: it never covers the text the user is working on.
/// It has four homes in the corners of the screen's visible frame and keeps the one it is in
/// while that one is clear, so it does not jump with every keystroke. When the field or the
/// caret comes near, it moves to the first clear home.
public enum PerchPlacement {
    public enum Home: String, Codable, Sendable, CaseIterable {
        case bottomRight, topRight, bottomLeft, topLeft
    }

    /// Distance from the visible frame's edges. Assumed.
    public static let inset: CGFloat = 10
    /// How close the field or caret may come before the perch moves. Assumed: about two lines of
    /// text, so the perch has gone before the caret reaches it.
    public static let clearance: CGFloat = 32

    /// The perch's frame at `home` within `visible` (global, top-left origin).
    public static func frame(_ home: Home, size: CGSize, in visible: CGRect) -> CGRect {
        let x = (home == .bottomRight || home == .topRight) ? visible.maxX - inset - size.width : visible.minX + inset
        let y = (home == .bottomRight || home == .bottomLeft) ? visible.maxY - inset - size.height : visible.minY + inset
        return CGRect(x: x, y: y, width: size.width, height: size.height)
    }

    public struct Choice: Equatable, Sendable {
        public var home: Home
        public var frame: CGRect
        /// True when no home is clear of the caret and the field, so the perch covers part of
        /// the field (a text view that fills the screen). It never covers the caret while any
        /// home is clear of it.
        public var overlapsField: Bool
        public var overlapsCaret: Bool
    }

    /// Keeps `current` while it is clear of both; else the first home clear of both; else the
    /// first clear of the caret (a field larger than the screen's corners); else the home farthest
    /// from the caret.
    public static func choose(visible: CGRect, size: CGSize, field: CGRect?, caret: CGRect?, current: Home?) -> Choice {
        func near(_ frame: CGRect, _ rect: CGRect?) -> Bool {
            guard let rect, !rect.isNull else { return false }
            return frame.insetBy(dx: -clearance, dy: -clearance).intersects(rect)
        }
        func choice(_ pair: (home: Home, frame: CGRect)) -> Choice {
            Choice(home: pair.home, frame: pair.frame, overlapsField: near(pair.frame, field), overlapsCaret: near(pair.frame, caret))
        }
        let all = Home.allCases.map { (home: $0, frame: frame($0, size: size, in: visible)) }
        let kept = all.first { $0.home == current }
        let clearOfBoth = { (p: (home: Home, frame: CGRect)) in !near(p.frame, field) && !near(p.frame, caret) }
        let clearOfCaret = { (p: (home: Home, frame: CGRect)) in !near(p.frame, caret) }
        if let kept, clearOfBoth(kept) { return choice(kept) }
        if let first = all.first(where: clearOfBoth) { return choice(first) }
        if let kept, clearOfCaret(kept) { return choice(kept) }
        if let first = all.first(where: clearOfCaret) { return choice(first) }
        let center = caret.map { CGPoint(x: $0.midX, y: $0.midY) } ?? CGPoint(x: visible.midX, y: visible.midY)
        let distance = { (p: (home: Home, frame: CGRect)) in hypot(p.frame.midX - center.x, p.frame.midY - center.y) }
        return choice(all.max { distance($0) < distance($1) }!)
    }
}
