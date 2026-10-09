import CaretScreenCore
import CoreGraphics
import Foundation

/// The perch: which background task Caret reports on and how (plan section 3, "Reporting"). Since
/// v3 the figure perches on the window that task works in, with a rim and a caption (`Rim`); this
/// file decides the task and its mood, and `PerchController` draws them.
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
        /// The window's frame when the task last changed (`TaskRecord.frame`), global top-left
        /// points: how the host finds the window first (`TaskWindow`).
        public var windowFrame: CGRect?
        public var app: String?
        /// Rows in the list's Needs you section, including this one.
        public var needsYou: Int

        public init(taskId: String, mood: Mood, pid: Int32?, windowId: String?, windowTitle: String?, windowFrame: CGRect? = nil, app: String?, needsYou: Int) {
            self.taskId = taskId
            self.mood = mood
            self.pid = pid
            self.windowId = windowId
            self.windowTitle = windowTitle
            self.windowFrame = windowFrame
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
        let candidates: [(TaskRecord, Mood)] = records.compactMap { r -> (TaskRecord, Mood)? in
            guard let mood = mood(for: r.state) else { return nil }
            // Done by the user's own hand (a prepared offer they typed out, a watched window they
            // closed): no gesture of relief for work Caret did not do.
            if r.state == .done, r.cause == .you { return nil }
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
        let urgent: (TaskRecord, Mood)? = candidates.filter { $0.1 == Mood.needsYou }.sorted(by: newest).first
        guard let pick = urgent ?? candidates.sorted(by: newest).first else { return nil }
        let (record, mood) = pick
        return Subject(
            taskId: record.id, mood: mood, pid: record.app.map { Int32(truncatingIfNeeded: $0.pid) },
            windowId: record.windowId, windowTitle: record.windowTitle,
            windowFrame: record.frame.map { CGRect(x: $0.x, y: $0.y, width: $0.width, height: $0.height) }, app: record.app?.name,
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

// MARK: - The task's window

/// Finds a task's window among its app's windows. By frame first (`TaskRecord.frame`): a title
/// changes as a document is edited, and two windows can share one. Then by title. Nil when neither
/// matches; the caller falls back to the app's main window.
public enum TaskWindow {
    public struct Candidate: Equatable, Sendable {
        public var frame: CGRect?
        public var title: String?

        public init(frame: CGRect?, title: String?) {
            self.frame = frame
            self.title = title
        }
    }

    /// The index of the task's window in `windows`, or nil. A frame matches within a point, as a
    /// fill's field does (`FillSelection.matches`); a frame shared by two windows decides nothing,
    /// and the title breaks the tie.
    public static func pick(frame: CGRect?, title: String?, among windows: [Candidate]) -> Int? {
        if let frame {
            let want = Frame(x: frame.minX, y: frame.minY, width: frame.width, height: frame.height)
            let byFrame = windows.indices.filter { i in
                guard let f = windows[i].frame else { return false }
                return FillSelection.matches(want, Frame(x: f.minX, y: f.minY, width: f.width, height: f.height))
            }
            if byFrame.count == 1 { return byFrame[0] }
            if byFrame.count > 1, let title, let i = byFrame.first(where: { windows[$0].title == title }) { return i }
            if let first = byFrame.first { return first }
        }
        if let title, !title.isEmpty { return windows.firstIndex { $0.title == title } }
        return nil
    }
}
