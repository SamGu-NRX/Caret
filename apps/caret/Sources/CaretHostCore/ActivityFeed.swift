import CaretScreenCore
import Foundation

/// The host's copy of the helper's task registry (`helper/src/tasks/registry.ts`).
///
/// Built from one `activityReply` to a `list` request and kept current by the `activity` messages
/// the helper broadcasts. Every activity message carries the whole record, so applying one is a
/// replacement, never a merge. A sequence number that skips means messages were lost; the record
/// that arrived is still applied, and the caller lists again to pick up whatever else changed.
public struct ActivityFeed: Equatable, Sendable {
    public private(set) var tasks: [String: TaskRecord] = [:]
    /// The sequence number of the last message applied, or of the last list.
    public private(set) var seq = 0
    /// A list reply has been applied since the last reset, so a skipped sequence number is a real gap.
    public private(set) var listed = false
    /// The last list reply was cut at the helper's 1 MiB cap (`truncated`): records it left out,
    /// the oldest, may exist that this copy has never seen.
    public private(set) var incomplete = false

    public init() {}

    public enum Applied: Equatable, Sendable {
        case applied
        /// Already covered by a newer message or list.
        case stale
        /// Applied, but messages before it were missed: list again.
        case gap
    }

    public mutating func apply(_ activity: Activity) -> Applied {
        if listed, activity.seq <= seq { return .stale }
        let skipped = listed && activity.seq != seq + 1
        tasks[activity.task.id] = activity.task
        seq = max(seq, activity.seq)
        return skipped ? .gap : .applied
    }

    /// Replaces every record with the reply to a `list` request (the host sends no `since`
    /// requests, so the caller passes only replies to its own list requests). A reply older than
    /// what is already applied is ignored; an error reply changes nothing. Returns whether the
    /// reply was applied.
    ///
    /// A truncated reply left out records that would not fit; they are not gone. Records this copy
    /// already holds and the reply did not carry are kept when they are no newer than the oldest
    /// the reply carried, since those are the ones the cap drops (registry.ts `list`, newest first).
    @discardableResult
    public mutating func applyList(_ reply: ActivityReply) -> Bool {
        guard reply.error == nil, !listed || reply.seq >= seq else { return false }
        var next = Dictionary(reply.tasks.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        if reply.truncated {
            let oldest = reply.tasks.map(\.updatedAt).min() ?? .max
            for (id, record) in tasks where next[id] == nil && record.updatedAt <= oldest { next[id] = record }
        }
        tasks = next
        seq = reply.seq
        listed = true
        incomplete = reply.truncated
        return true
    }

    /// The helper went away: its registry is in memory, so a new session starts empty.
    public mutating func reset() {
        tasks = [:]
        seq = 0
        listed = false
        incomplete = false
    }

    public var records: [TaskRecord] { Array(tasks.values) }
}

// MARK: - The activity list

/// What a row's buttons do. Each sends one `taskControl` with the matching action.
public enum RowAction: String, Codable, Sendable, CaseIterable {
    case takeOver, resume, undo

    public var control: TaskControl.Action {
        switch self {
        case .takeOver: return .takeOver
        case .resume: return .resume
        case .undo: return .undo
        }
    }

    public var label: String {
        switch self {
        case .takeOver: return "Take over"
        case .resume: return "Continue"
        case .undo: return "Undo"
        }
    }
}

/// One row of the activity list (plan section 3, "Reporting"): the end state as a sentence, the
/// app, where the run is, and its buttons.
public struct ActivityRow: Equatable, Sendable, Codable, Identifiable {
    public enum Section: String, Codable, Sendable, CaseIterable {
        case needsYou, inProgress, done

        public var title: String {
            switch self {
            case .needsYou: return "Needs you"
            case .inProgress: return "In progress"
            case .done: return "Done today"
            }
        }
    }

    public var id: String
    public var section: Section
    public var state: TaskState
    public var says: String
    public var app: String?
    /// "Step 4 of 6", "Stopped before step 3 of 6", "Watching". Nil when there is nothing to add.
    public var progress: String?
    public var actions: [RowAction]
    public var updatedAt: Int64

    public init(id: String, section: Section, state: TaskState, says: String, app: String?, progress: String?, actions: [RowAction], updatedAt: Int64) {
        self.id = id
        self.section = section
        self.state = state
        self.says = says
        self.app = app
        self.progress = progress
        self.actions = actions
        self.updatedAt = updatedAt
    }
}

public enum ActivityList {
    /// Done rows shown at most, per page. The list is a glance, not a log. No measurement behind
    /// the number.
    public static let maxDone = 5

    /// The rows one look at the list shows, and how many Done rows from today wait behind
    /// "and N more".
    public struct Page: Equatable, Sendable {
        public var rows: [ActivityRow]
        public var more: Int
    }

    /// `pages` pages of Done rows (5 each); every Needs you and In progress row is always listed,
    /// so no Continue or Undo is out of reach.
    public static func page(_ records: [TaskRecord], now: Date, pages: Int = 1, calendar: Calendar = .current) -> Page {
        let all = rows(records, now: now, calendar: calendar, maxDone: .max)
        let limit = maxDone * max(pages, 1)
        let done = all.filter { $0.section == .done }.count
        var shown = 0
        let kept = all.filter { row in
            guard row.section == .done else { return true }
            shown += 1
            return shown <= limit
        }
        return Page(rows: kept, more: max(done - limit, 0))
    }

    /// The rows in list order: Needs you, In progress, Done today, each newest first. A prepared
    /// offer (`ready`) is not listed: it is still an offer at the caret, not work.
    public static func rows(_ records: [TaskRecord], now: Date, calendar: Calendar = .current, maxDone: Int = ActivityList.maxDone) -> [ActivityRow] {
        let startOfDay = Int64(calendar.startOfDay(for: now).timeIntervalSince1970 * 1000)
        var rows = records.compactMap { row(for: $0) }
        rows.removeAll { $0.section == .done && $0.updatedAt < startOfDay }
        rows.sort {
            let a = ActivityRow.Section.order($0.section), b = ActivityRow.Section.order($1.section)
            return a != b ? a < b : ($0.updatedAt != $1.updatedAt ? $0.updatedAt > $1.updatedAt : $0.id < $1.id)
        }
        var done = 0
        return rows.filter { row in
            guard row.section == .done else { return true }
            done += 1
            return done <= maxDone
        }
    }

    public static func row(for r: TaskRecord) -> ActivityRow? {
        let section: ActivityRow.Section
        var actions: [RowAction] = []
        var progress: String?
        switch r.state {
        case .ready:
            return nil
        case .preparing:
            section = .inProgress
            progress = "Starting"
        case .running:
            section = .inProgress
            if r.kind == .watch {
                progress = "Watching"
            } else {
                progress = stepText(r, prefix: "Step")
                actions = [.takeOver]
            }
        case .paused:
            section = .needsYou
            progress = stepText(r, prefix: "Stopped before step") ?? "Paused"
            actions = r.kind == .watch ? [.resume] : (r.undoable ? [.resume, .undo] : [.resume])
        case .needsYou:
            section = .needsYou
            progress = r.kind == .watch ? "Waiting for you" : stepText(r, prefix: "Handed back at step")
            if r.undoable { actions = [.undo] }
        case .done:
            // A prepared offer the user typed out by hand ends without a row: Caret did not do it.
            if r.cause == .you, r.kind == .loopFinish || r.kind == .routine { return nil }
            section = .done
            if r.undoable { actions = [.undo] }
        case .failed:
            section = .done
            progress = stepText(r, prefix: "Stopped at step") ?? "Didn't finish"
            if r.undoable { actions = [.undo] }
        case .undone:
            section = .done
            // The helper reports a partial undo as undone with writes still restorable; the row
            // keeps Undo so the user can try the rest again.
            progress = r.undoable ? "Partly undone" : "Undone"
            if r.undoable { actions = [.undo] }
        }
        return ActivityRow(id: r.id, section: section, state: r.state, says: r.says, app: r.app?.name, progress: progress, actions: actions, updatedAt: r.updatedAt)
    }

    /// "Step 4 of 6" from the zero-based `step`. Nil without both numbers.
    static func stepText(_ r: TaskRecord, prefix: String) -> String? {
        guard let step = r.step, let steps = r.steps, steps > 0 else { return nil }
        return "\(prefix) \(min(step + 1, steps)) of \(steps)"
    }

    /// The rows that need the user: what the perch's count shows.
    public static func needsYouCount(_ records: [TaskRecord]) -> Int {
        records.filter { $0.state == .needsYou || $0.state == .paused }.count
    }
}

extension ActivityRow.Section {
    static func order(_ s: Self) -> Int {
        switch s {
        case .needsYou: return 0
        case .inProgress: return 1
        case .done: return 2
        }
    }
}
