// Swift mirror of the task, activity and fill-result messages in helper/src/protocol.ts, for the
// host: it sends fillResult, taskControl and activityRequest, and receives activity and activityReply.
// The golden fixture holds one line of each.
import Foundation

/// The host's report on one field of a fill proposal.
public struct FillResult: Codable, Equatable, Sendable {
    public static let type = "fillResult"
    public enum Outcome: String, Codable, Sendable { case inserted, rejected, failed, undone, undoFailed }
    public enum Method: String, Codable, Sendable { case pastePid, axSelectedText, axValue }
    public var at: Int64
    public var proposalId: String
    public var windowId: String
    public var fieldKey: String
    public var outcome: Outcome
    public var reason: String?
    public var method: Method?
    public var valueLength: Int
    public init(at: Int64, proposalId: String, windowId: String, fieldKey: String, outcome: Outcome, reason: String?, method: Method?, valueLength: Int) {
        self.at = at; self.proposalId = proposalId; self.windowId = windowId; self.fieldKey = fieldKey
        self.outcome = outcome; self.reason = reason; self.method = method; self.valueLength = valueLength
    }
    enum CodingKeys: String, CodingKey { case at, proposalId, windowId, fieldKey, outcome, reason, method, valueLength }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        at = try c.decode(Int64.self, forKey: .at); proposalId = try c.decode(String.self, forKey: .proposalId)
        windowId = try c.decode(String.self, forKey: .windowId); fieldKey = try c.decode(String.self, forKey: .fieldKey)
        outcome = try c.decode(Outcome.self, forKey: .outcome); reason = try c.decodeNullable(String.self, forKey: .reason)
        method = try c.decodeNullable(Method.self, forKey: .method); valueLength = try c.decode(Int.self, forKey: .valueLength)
        if valueLength < 0 { throw ProtocolError("valueLength is negative") }
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(at, forKey: .at); try c.encode(proposalId, forKey: .proposalId); try c.encode(windowId, forKey: .windowId)
        try c.encode(fieldKey, forKey: .fieldKey); try c.encode(outcome, forKey: .outcome); try c.encode(reason, forKey: .reason)
        try c.encode(method, forKey: .method); try c.encode(valueLength, forKey: .valueLength)
    }
}

/// Controls one task in the activity feed. A watch takes pause, resume and stop only.
public struct TaskControl: Codable, Equatable, Sendable {
    public static let type = "taskControl"
    public enum Action: String, Codable, Sendable { case pause, resume, stop, takeOver, undo }
    /// Why the host paused. `input`: it saw the user's own input in the task's window; the run then keeps
    /// the reader's wording for the pause ("typing in 'Claim form'") when the reader saw it too.
    public enum Reason: String, Codable, Sendable { case input }
    public var taskId: String
    public var action: Action
    /// Only with `pause`; the helper refuses it with any other action.
    public var reason: Reason?
    public init(taskId: String, action: Action, reason: Reason? = nil) { self.taskId = taskId; self.action = action; self.reason = reason }
    enum CodingKeys: String, CodingKey { case taskId, action, reason }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        taskId = try c.decode(String.self, forKey: .taskId); action = try c.decode(Action.self, forKey: .action)
        reason = try c.decodeOptional(Reason.self, forKey: .reason)
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(taskId, forKey: .taskId); try c.encode(action, forKey: .action); try c.encodeIfPresent(reason, forKey: .reason)
    }
}

/// `list` asks for every task record; `since` for the activity messages after sequence number `since`.
/// `requestId` is 1 to 200 characters, since the size-capped reply echoes it.
public struct ActivityRequest: Codable, Equatable, Sendable {
    public static let type = "activityRequest"
    public enum Op: String, Codable, Sendable { case list, since }
    public var requestId: String
    public var op: Op
    public var since: Int?
    public init(requestId: String, op: Op, since: Int? = nil) { self.requestId = requestId; self.op = op; self.since = since }
    enum CodingKeys: String, CodingKey { case requestId, op, since }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        requestId = try c.decode(String.self, forKey: .requestId); op = try c.decode(Op.self, forKey: .op)
        since = try c.decodeOptional(Int.self, forKey: .since)
        // zod counts UTF-16 code units.
        if requestId.isEmpty || requestId.utf16.count > 200 { throw ProtocolError("requestId must be 1 to 200 characters") }
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(requestId, forKey: .requestId); try c.encode(op, forKey: .op)
        try c.encodeIfPresent(since, forKey: .since)
    }
}

public enum TaskState: String, Codable, Sendable, CaseIterable {
    case preparing, ready, running, paused, needsYou, done, failed, undone
}
public enum TaskCause: String, Codable, Sendable { case caret, you, screen }
public enum TaskKind: String, Codable, Sendable { case plan, loopFinish, routine, watch }

public struct PendingAnswer: Codable, Equatable, Sendable {
    public var choice: String
    public var confidence: Double
}

/// A watch's reading of its window and Jev's latest two answers.
public struct PendingInfo: Codable, Equatable, Sendable {
    public var markedBy: String
    public var status: String?
    public var finished: PendingAnswer?
    public var waiting: PendingAnswer?
    public var asks: Int
    enum CodingKeys: String, CodingKey { case markedBy, status, finished, waiting, asks }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        markedBy = try c.decode(String.self, forKey: .markedBy); status = try c.decodeNullable(String.self, forKey: .status)
        finished = try c.decodeNullable(PendingAnswer.self, forKey: .finished); waiting = try c.decodeNullable(PendingAnswer.self, forKey: .waiting)
        asks = try c.decode(Int.self, forKey: .asks)
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(markedBy, forKey: .markedBy); try c.encode(status, forKey: .status)
        try c.encode(finished, forKey: .finished); try c.encode(waiting, forKey: .waiting); try c.encode(asks, forKey: .asks)
    }
}

/// One piece of Caret's work, as the activity view shows it.
public struct TaskRecord: Codable, Equatable, Sendable {
    public var id: String
    public var kind: TaskKind
    public var state: TaskState
    public var cause: TaskCause?
    public var says: String
    public var app: AppRef?
    public var windowId: String?
    public var windowTitle: String?
    /// The task window's frame when the record last changed state or step; nil before it has a window.
    public var frame: Frame?
    /// Zero-based index of the step the run is at, or stopped or paused before.
    public var step: Int?
    public var steps: Int?
    public var stepSays: String?
    /// End states not yet reached, from `step` on.
    public var remaining: [String]
    public var detail: String?
    public var undoable: Bool
    public var startedAt: Int64
    public var updatedAt: Int64
    public var pending: PendingInfo?
    enum CodingKeys: String, CodingKey {
        case id, kind, state, cause, says, app, windowId, windowTitle, frame, step, steps, stepSays, remaining, detail, undoable, startedAt, updatedAt, pending
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id); kind = try c.decode(TaskKind.self, forKey: .kind)
        state = try c.decode(TaskState.self, forKey: .state); cause = try c.decodeNullable(TaskCause.self, forKey: .cause)
        says = try c.decode(String.self, forKey: .says); app = try c.decodeNullable(AppRef.self, forKey: .app)
        windowId = try c.decodeNullable(String.self, forKey: .windowId); windowTitle = try c.decodeNullable(String.self, forKey: .windowTitle)
        frame = try c.decodeNullable(Frame.self, forKey: .frame)
        step = try c.decodeNullable(Int.self, forKey: .step); steps = try c.decodeNullable(Int.self, forKey: .steps)
        stepSays = try c.decodeNullable(String.self, forKey: .stepSays); remaining = try c.decode([String].self, forKey: .remaining)
        detail = try c.decodeNullable(String.self, forKey: .detail); undoable = try c.decode(Bool.self, forKey: .undoable)
        startedAt = try c.decode(Int64.self, forKey: .startedAt); updatedAt = try c.decode(Int64.self, forKey: .updatedAt)
        pending = try c.decodeNullable(PendingInfo.self, forKey: .pending)
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id); try c.encode(kind, forKey: .kind); try c.encode(state, forKey: .state)
        try c.encode(cause, forKey: .cause); try c.encode(says, forKey: .says); try c.encode(app, forKey: .app)
        try c.encode(windowId, forKey: .windowId); try c.encode(windowTitle, forKey: .windowTitle); try c.encode(frame, forKey: .frame)
        try c.encode(step, forKey: .step); try c.encode(steps, forKey: .steps); try c.encode(stepSays, forKey: .stepSays)
        try c.encode(remaining, forKey: .remaining); try c.encode(detail, forKey: .detail); try c.encode(undoable, forKey: .undoable)
        try c.encode(startedAt, forKey: .startedAt); try c.encode(updatedAt, forKey: .updatedAt); try c.encode(pending, forKey: .pending)
    }
}

/// One transition (or step change) of one task. `seq` rises by one per message.
public struct Activity: Codable, Equatable, Sendable {
    public static let type = "activity"
    public var seq: Int
    public var at: Int64
    /// The state before this message; nil when the record is new.
    public var from: TaskState?
    public var task: TaskRecord
    enum CodingKeys: String, CodingKey { case seq, at, from, task }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        seq = try c.decode(Int.self, forKey: .seq); at = try c.decode(Int64.self, forKey: .at)
        from = try c.decodeNullable(TaskState.self, forKey: .from); task = try c.decode(TaskRecord.self, forKey: .task)
        if seq < 1 { throw ProtocolError("seq must be positive") }
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(seq, forKey: .seq); try c.encode(at, forKey: .at); try c.encode(from, forKey: .from); try c.encode(task, forKey: .task)
    }
}

/// The answer to one activityRequest. `list` fills `tasks`; `since` fills `events`.
public struct ActivityReply: Codable, Equatable, Sendable {
    public static let type = "activityReply"
    public var requestId: String
    public var error: String?
    public var seq: Int
    public var tasks: [TaskRecord]
    public var events: [Activity]
    /// The reply is incomplete. For `list`, the oldest records were left out to stay under 1 MiB; for
    /// `since`, events after `since` were dropped from the helper's buffer or left out, so list instead.
    public var truncated: Bool
    enum CodingKeys: String, CodingKey { case requestId, error, seq, tasks, events, truncated }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        requestId = try c.decode(String.self, forKey: .requestId); error = try c.decodeNullable(String.self, forKey: .error)
        seq = try c.decode(Int.self, forKey: .seq); tasks = try c.decode([TaskRecord].self, forKey: .tasks)
        events = try c.decode([Activity].self, forKey: .events); truncated = try c.decode(Bool.self, forKey: .truncated)
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(requestId, forKey: .requestId); try c.encode(error, forKey: .error); try c.encode(seq, forKey: .seq)
        try c.encode(tasks, forKey: .tasks); try c.encode(events, forKey: .events); try c.encode(truncated, forKey: .truncated)
    }
}
