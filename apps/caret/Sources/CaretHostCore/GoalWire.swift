import CaretScreenCore
import Foundation

// Goal plans on the wire (helper/src/protocol.ts, D2-06, B30, G2, H9's goalEdit and H11's page view). A
// host whose hello names `goalPlans` gets an Ask's page fill (P2) back as a goal: a preview of its first
// segment, accepted with `goalAccept` naming that preview's digest, one segment per acceptance. The golden
// lines are helper/fixtures/golden/plan-run.ndjson and page-goal.ndjson, copied byte for byte into the
// host's test fixtures. H9 wrote these types on v2/goals-ui; H11 brought them over and added the page view.
//
// Decoding is as strict as the helper's schema: an unknown event, reason or outcome, a digest that is
// not 64 lowercase hex digits, or a missing nullable key fails the line, which the host counts as
// undecodable rather than guess at.

public enum GoalPlans {
    /// The hello capability (protocol.ts GOAL_PLANS_CAPABILITY).
    public static let capability = "goalPlans"

    static func digest(_ s: String) throws -> String {
        guard s.utf8.count == 64, s.utf8.allSatisfy({ (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }) else {
            throw ProtocolError("a digest is 64 lowercase hex digits")
        }
        return s
    }

    static func envelope<K: CodingKey>(_ c: KeyedDecodingContainer<K>, type expected: String, typeKey: K, vKey: K) throws {
        let type = try c.decode(String.self, forKey: typeKey)
        guard type == expected else { throw ProtocolError("expected \(expected), got \(type)") }
        let v = try c.decode(Int.self, forKey: vKey)
        guard v == Proto.version else { throw ProtocolError("unsupported protocol version \(v) for \(type)") }
    }

    /// A key the schema requires even when its value is null.
    static func nullable<T: Decodable, K: CodingKey>(_ t: T.Type, _ c: KeyedDecodingContainer<K>, _ key: K) throws -> T? {
        guard c.contains(key) else { throw ProtocolError("missing \(key.stringValue); send null instead") }
        return try c.decodeIfPresent(t, forKey: key)
    }
}

/// Host to helper: plan this as a goal. The desk asks through `planRequest`, whose plan route the helper
/// answers as a goal for this host (B30); this mirror decodes the golden lines and the echo.
public struct GoalRequest: Codable, Equatable, Sendable {
    public static let type = "goalRequest"
    public var requestId: String
    public var instruction: String
    public var at: Int64

    public init(requestId: String, instruction: String, at: Int64) {
        self.requestId = requestId
        self.instruction = instruction
        self.at = at
    }

    enum CodingKeys: String, CodingKey { case type, v, requestId, instruction, at }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try GoalPlans.envelope(c, type: Self.type, typeKey: .type, vKey: .v)
        requestId = try c.decode(String.self, forKey: .requestId)
        instruction = try c.decode(String.self, forKey: .instruction)
        at = try c.decode(Int64.self, forKey: .at)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.type, forKey: .type); try c.encode(Proto.version, forKey: .v)
        try c.encode(requestId, forKey: .requestId); try c.encode(instruction, forKey: .instruction); try c.encode(at, forKey: .at)
    }
}

/// Host to helper: the user's Tab on segment `segment` of goal `goalId`, as previewed under `digest`.
/// The helper refuses any other plan, a segment accepted before, another connection's, or one after the
/// preview expired, by name, and runs nothing.
public struct GoalAccept: Codable, Equatable, Sendable {
    public static let type = "goalAccept"
    /// P3, H14: the file the user confirmed in this preview for attach step `step`: one they chose in the attach
    /// row's file chooser, or the saved file the row offered and they confirmed with ⌘2 or a click. Never a file Tab
    /// alone chose (`PageTask.tab`).
    public struct ConfirmedFile: Codable, Equatable, Sendable {
        public var step: Int
        /// Absolute.
        public var path: String

        public init(step: Int, path: String) {
            self.step = step
            self.path = path
        }
    }

    public var goalId: String
    public var segment: Int
    public var digest: String
    public var at: Int64
    public var confirmedFile: ConfirmedFile?

    public init(goalId: String, segment: Int, digest: String, at: Int64, confirmedFile: ConfirmedFile? = nil) {
        self.goalId = goalId
        self.segment = segment
        self.digest = digest
        self.at = at
        self.confirmedFile = confirmedFile
    }

    enum CodingKeys: String, CodingKey { case type, v, goalId, segment, digest, at, confirmedFile }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try GoalPlans.envelope(c, type: Self.type, typeKey: .type, vKey: .v)
        goalId = try c.decode(String.self, forKey: .goalId)
        segment = try c.decode(Int.self, forKey: .segment)
        digest = try GoalPlans.digest(try c.decode(String.self, forKey: .digest))
        at = try c.decode(Int64.self, forKey: .at)
        confirmedFile = try c.decodeIfPresent(ConfirmedFile.self, forKey: .confirmedFile)
        guard segment >= 0 else { throw ProtocolError("goalAccept segment is negative") }
        // protocol.ts AbsolutePath.
        if let f = confirmedFile, f.step < 0 || !GoalFiles.isAbsolutePath(f.path) {
            throw ProtocolError("a confirmed file names its attach step and an absolute path")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.type, forKey: .type); try c.encode(Proto.version, forKey: .v)
        try c.encode(goalId, forKey: .goalId); try c.encode(segment, forKey: .segment)
        try c.encode(digest, forKey: .digest); try c.encode(at, forKey: .at)
        try c.encodeIfPresent(confirmedFile, forKey: .confirmedFile)
    }
}

/// Host to helper (H9): the user's words in place of the draft at step `step` of the segment previewed
/// under `digest`. The helper previews that segment again with them under a new digest, which needs its
/// own Tab; nothing runs.
public struct GoalEdit: Codable, Equatable, Sendable {
    public static let type = "goalEdit"
    /// protocol.ts caps the words as it caps a draft.
    public static let maxText = 600
    public var goalId: String
    public var segment: Int
    public var digest: String
    public var step: Int
    public var text: String
    public var at: Int64

    public init(goalId: String, segment: Int, digest: String, step: Int, text: String, at: Int64) {
        self.goalId = goalId
        self.segment = segment
        self.digest = digest
        self.step = step
        self.text = text
        self.at = at
    }

    enum CodingKeys: String, CodingKey { case type, v, goalId, segment, digest, step, text, at }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try GoalPlans.envelope(c, type: Self.type, typeKey: .type, vKey: .v)
        goalId = try c.decode(String.self, forKey: .goalId)
        segment = try c.decode(Int.self, forKey: .segment)
        digest = try GoalPlans.digest(try c.decode(String.self, forKey: .digest))
        step = try c.decode(Int.self, forKey: .step)
        text = try c.decode(String.self, forKey: .text)
        at = try c.decode(Int64.self, forKey: .at)
        guard segment >= 0, step >= 0 else { throw ProtocolError("goalEdit segment and step are not negative") }
        guard !text.isEmpty, text.count <= Self.maxText else { throw ProtocolError("goalEdit text is 1 to \(Self.maxText) characters") }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.type, forKey: .type); try c.encode(Proto.version, forKey: .v)
        try c.encode(goalId, forKey: .goalId); try c.encode(segment, forKey: .segment); try c.encode(digest, forKey: .digest)
        try c.encode(step, forKey: .step); try c.encode(text, forKey: .text); try c.encode(at, forKey: .at)
    }
}

/// Helper to a goal-planning host: a goal's preview, each step's receipt, its stop, or its end.
public struct GoalProgress: Codable, Equatable, Sendable {
    public static let type = "goalProgress"

    public var at: Int64
    public var goalId: String
    /// The request this answers (an Ask's, for a goal from the desk); null on every later message.
    public var requestId: String?
    public var event: Event

    public enum Event: Equatable, Sendable {
        case segment(Preview)
        case step(Receipt)
        case stopped(Stop)
        case finished(End)
    }

    /// One segment waiting for its own Tab until `expires`.
    public struct Preview: Equatable, Sendable {
        /// `nextPage` (P3): the user's own Next took the page to a new document, and the goal was planned again there.
        /// `moreFields` (C2): a form over 20 fields fills in parts, each previewed and accepted with its own Tab.
        public enum Reason: String, Codable, Sendable { case start, crossWindow, afterReveal, freshPlan, nextPage, moreFields }
        public var segment: Int
        public var segments: Int
        public var reason: Reason
        /// The goal this fresh plan replaces, on its first segment.
        public var replaces: String?
        public var digest: String
        public var expires: Int64
        public var place: Place
        public var steps: [Step]
        public var warnings: [String]
        /// H11: how a page segment reads in the page task panel; nil for every other segment.
        public var page: PageView?

        public init(segment: Int, segments: Int, reason: Reason, replaces: String?, digest: String, expires: Int64, place: Place, steps: [Step], warnings: [String], page: PageView? = nil) {
            self.segment = segment
            self.segments = segments
            self.reason = reason
            self.replaces = replaces
            self.digest = digest
            self.expires = expires
            self.place = place
            self.steps = steps
            self.warnings = warnings
            self.page = page
        }
    }

    /// H11 (protocol.ts GoalPageView): a page segment as the panel shows it. Not under the digest; every
    /// value in it is a step's.
    public struct PageView: Codable, Equatable, Sendable {
        public struct Row: Codable, Equatable, Sendable {
            /// The write step's index in the goal.
            public var step: Int
            public var label: String
            public var value: String
            /// Chosen from a list the page offers (a select or a combobox).
            public var picked: Bool

            public init(step: Int, label: String, value: String, picked: Bool) {
                self.step = step
                self.label = label
                self.value = value
                self.picked = picked
            }
        }

        /// H14 (protocol.ts GoalPageView.files): an attach step's row as the panel shows it.
        public struct FileRow: Codable, Equatable, Sendable {
            /// The attach step's index in the goal.
            public var step: Int
            /// The file control's name on the page: "Resume", "Or drop your resume here".
            public var label: String
            /// The control's accept tokens, lowercased (".pdf", "application/pdf", "image/*"); empty when it takes any file.
            public var accept: [String]

            public init(step: Int, label: String, accept: [String]) {
                self.step = step
                self.label = label
                self.accept = accept
            }
        }

        public var windowId: String
        /// The browser the page is in: Tab and Esc for the panel are the keys headed to its pid.
        public var app: AppRef
        /// The first field the segment writes, global top-left points, when it lies in the viewport.
        public var anchor: Frame?
        /// The page's visible area on screen; nil when the walk did not say.
        public var viewport: Frame?
        /// Where the values came from, without "from": "Notes, Robin's details and what you told Caret".
        public var from: String
        public var rows: [Row]
        /// Empty file inputs the Ask's scope takes, which Caret leaves to the user: those with no attach step.
        public var attach: [String]
        /// H14: each attach step's row; nil from a helper before H14, or when the segment attaches nothing.
        public var files: [FileRow]?

        public init(windowId: String, app: AppRef, anchor: Frame?, viewport: Frame?, from: String, rows: [Row], attach: [String], files: [FileRow]? = nil) {
            self.windowId = windowId
            self.app = app
            self.anchor = anchor
            self.viewport = viewport
            self.from = from
            self.rows = rows
            self.attach = attach
            self.files = files
        }

        enum CodingKeys: String, CodingKey { case windowId, app, anchor, viewport, from, rows, attach, files }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            windowId = try c.decode(String.self, forKey: .windowId)
            app = try c.decode(AppRef.self, forKey: .app)
            anchor = try GoalPlans.nullable(Frame.self, c, .anchor)
            viewport = try GoalPlans.nullable(Frame.self, c, .viewport)
            from = try c.decode(String.self, forKey: .from)
            rows = try c.decode([Row].self, forKey: .rows)
            attach = try c.decode([String].self, forKey: .attach)
            files = try c.decodeIfPresent([FileRow].self, forKey: .files)
            guard !windowId.isEmpty else { throw ProtocolError("a page view names its page window") }
            if let files {
                guard files.count <= 8, Set(files.map(\.step)).count == files.count,
                      files.allSatisfy({ $0.step >= 0 && !$0.label.isEmpty && $0.label.count <= 300 && $0.accept.count <= 20 && $0.accept.allSatisfy { !$0.isEmpty && $0.count <= 100 } })
                else { throw ProtocolError("a page view has up to 8 file rows, one per attach step, each named") }
            }
            guard rows.count <= 24, rows.allSatisfy({ $0.step >= 0 }) else { throw ProtocolError("a page view has up to 24 rows, each a step") }
            guard attach.count <= 8, attach.allSatisfy({ !$0.isEmpty }) else { throw ProtocolError("a page view names up to 8 file inputs") }
        }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(windowId, forKey: .windowId); try c.encode(app, forKey: .app); try c.encode(anchor, forKey: .anchor); try c.encode(viewport, forKey: .viewport)
            try c.encode(from, forKey: .from); try c.encode(rows, forKey: .rows); try c.encode(attach, forKey: .attach)
            try c.encodeIfPresent(files, forKey: .files)
        }
    }

    /// Where a segment acts: one window, or the calendar.
    public enum Place: Equatable, Sendable {
        case window(app: String, title: String)
        case calendar(String)
    }

    /// One step as the user reads it. `drafted` is the whole text when Caret composed it (B30).
    public struct Step: Equatable, Sendable {
        public enum Kind: String, Codable, Sendable { case write, calendar, press, handoff, attach }
        /// P3 (protocol.ts GoalStepView.file): the file an attach step's row offers. Only a host that declared
        /// goalFiles gets attach steps (H14: `PageTask` shows each as an attach row).
        public enum File: Equatable, Sendable {
            case choose
            case saved(savedId: String, path: String, name: String, edited: Int64)
        }
        public var index: Int
        public var kind: Kind
        public var says: String
        public var drafted: String?
        public var file: File?

        public init(index: Int, kind: Kind, says: String, drafted: String? = nil, file: File? = nil) {
            self.index = index
            self.kind = kind
            self.says = says
            self.drafted = drafted
            self.file = file
        }
    }

    public struct Receipt: Equatable, Sendable {
        public enum Phase: String, Codable, Sendable { case verified, skipped, handoff }
        public var segment: Int
        public var taskId: String
        public var step: Int
        public var steps: Int
        public var phase: Phase
        public var says: String

        public init(segment: Int, taskId: String, step: Int, steps: Int, phase: Phase, says: String) {
            self.segment = segment
            self.taskId = taskId
            self.step = step
            self.steps = steps
            self.phase = phase
            self.says = says
        }
    }

    public enum StopReason: String, Codable, Sendable, CaseIterable {
        case refused, dialog, reload, sourceChanged, targetChanged, timeout, unexpectedEffect, handedOff, revealed
        case windowGone, you, readerRestarted, hostGone, expired, error
    }

    public struct Stop: Equatable, Sendable {
        public var segment: Int?
        public var step: Int?
        public var reason: StopReason
        public var says: String
        /// The goal id of the fresh plan offered in its place, which the next message previews.
        public var freshPlan: String?

        public init(segment: Int?, step: Int?, reason: StopReason, says: String, freshPlan: String?) {
            self.segment = segment
            self.step = step
            self.reason = reason
            self.says = says
            self.freshPlan = freshPlan
        }
    }

    public struct End: Equatable, Sendable {
        public enum Outcome: String, Codable, Sendable { case done, handoff, partial }
        public var outcome: Outcome
        public var verified: Int
        public var skipped: Int
        /// What is left, each in the preview's words; empty exactly when done (G2).
        public var left: [String]
        public var says: String

        public init(outcome: Outcome, verified: Int, skipped: Int, left: [String], says: String) {
            self.outcome = outcome
            self.verified = verified
            self.skipped = skipped
            self.left = left
            self.says = says
        }
    }

    public init(at: Int64, goalId: String, requestId: String?, event: Event) {
        self.at = at
        self.goalId = goalId
        self.requestId = requestId
        self.event = event
    }

    enum CodingKeys: String, CodingKey {
        case type, v, at, goalId, requestId, event
        case segment, segments, reason, replaces, digest, expires, `where`, steps, warnings, page
        case taskId, step, phase, says, freshPlan
        case outcome, verified, skipped, left
    }

    enum PlaceKeys: String, CodingKey { case kind, app, title, calendar }
    enum StepKeys: String, CodingKey { case index, kind, says, drafted, file }
    enum FileKeys: String, CodingKey { case source, savedId, path, name, edited }

    static func decodeFile(_ s: KeyedDecodingContainer<StepKeys>) throws -> Step.File? {
        guard s.contains(.file) else { return nil }
        let f = try s.nestedContainer(keyedBy: FileKeys.self, forKey: .file)
        switch try f.decode(String.self, forKey: .source) {
        case "choose": return .choose
        case "saved":
            let file = Step.File.saved(savedId: try f.decode(String.self, forKey: .savedId), path: try f.decode(String.self, forKey: .path),
                                       name: try f.decode(String.self, forKey: .name), edited: try f.decode(Int64.self, forKey: .edited))
            guard case .saved(let id, let path, let name, let edited) = file, !id.isEmpty, id.count <= 80, path.hasPrefix("/"),
                  !name.isEmpty, name.count <= 255, edited >= 0 else { throw ProtocolError("a saved file names its id, absolute path and name") }
            return file
        case let other: throw ProtocolError("unknown file source \(other)")
        }
    }

    static func encodeFile(_ file: Step.File, into e: inout KeyedEncodingContainer<StepKeys>) throws {
        var f = e.nestedContainer(keyedBy: FileKeys.self, forKey: .file)
        switch file {
        case .choose: try f.encode("choose", forKey: .source)
        case .saved(let id, let path, let name, let edited):
            try f.encode("saved", forKey: .source); try f.encode(id, forKey: .savedId); try f.encode(path, forKey: .path)
            try f.encode(name, forKey: .name); try f.encode(edited, forKey: .edited)
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        try GoalPlans.envelope(c, type: Self.type, typeKey: .type, vKey: .v)
        at = try c.decode(Int64.self, forKey: .at)
        goalId = try c.decode(String.self, forKey: .goalId)
        requestId = try GoalPlans.nullable(String.self, c, .requestId)
        guard !goalId.isEmpty else { throw ProtocolError("goalProgress needs a goalId") }
        switch try c.decode(String.self, forKey: .event) {
        case "segment":
            let p = try c.nestedContainer(keyedBy: PlaceKeys.self, forKey: .where)
            let place: Place
            switch try p.decode(String.self, forKey: .kind) {
            case "window": place = .window(app: try p.decode(String.self, forKey: .app), title: try p.decode(String.self, forKey: .title))
            case "calendar":
                let name = try p.decode(String.self, forKey: .calendar)
                guard !name.isEmpty else { throw ProtocolError("a calendar segment names its calendar") }
                place = .calendar(name)
            case let other: throw ProtocolError("unknown place kind \(other)")
            }
            var list = try c.nestedUnkeyedContainer(forKey: .steps)
            var steps: [Step] = []
            while !list.isAtEnd {
                let s = try list.nestedContainer(keyedBy: StepKeys.self)
                let step = Step(index: try s.decode(Int.self, forKey: .index), kind: try s.decode(Step.Kind.self, forKey: .kind),
                                says: try s.decode(String.self, forKey: .says), drafted: try s.decodeIfPresent(String.self, forKey: .drafted),
                                file: try Self.decodeFile(s))
                guard step.index >= 0, !step.says.isEmpty else { throw ProtocolError("a goal step has an index and words") }
                // protocol.ts GoalStepView's refine: an attach step names its file, and no other step does.
                guard (step.kind == .attach) == (step.file != nil) else { throw ProtocolError("an attach step names its file, and no other step does") }
                if let d = step.drafted, d.isEmpty || d.count > GoalEdit.maxText { throw ProtocolError("a drafted value is 1 to \(GoalEdit.maxText) characters") }
                steps.append(step)
            }
            guard (1...24).contains(steps.count) else { throw ProtocolError("a goal segment shows 1 to 24 steps") }
            let preview = Preview(
                segment: try c.decode(Int.self, forKey: .segment), segments: try c.decode(Int.self, forKey: .segments),
                reason: try c.decode(Preview.Reason.self, forKey: .reason), replaces: try GoalPlans.nullable(String.self, c, .replaces),
                digest: try GoalPlans.digest(try c.decode(String.self, forKey: .digest)), expires: try c.decode(Int64.self, forKey: .expires),
                place: place, steps: steps, warnings: try c.decode([String].self, forKey: .warnings),
                page: try c.decodeIfPresent(PageView.self, forKey: .page)
            )
            if let page = preview.page, let bad = page.rows.first(where: { r in !steps.contains { $0.index == r.step && $0.kind == .write } }) {
                throw ProtocolError("page row \(bad.step) is not a write step of the segment")
            }
            if let bad = preview.page?.files?.first(where: { r in !steps.contains { $0.index == r.step && $0.kind == .attach } }) {
                throw ProtocolError("page file row \(bad.step) is not an attach step of the segment")
            }
            guard preview.segment >= 0, preview.segments > preview.segment else { throw ProtocolError("a goal segment's index is under its count") }
            event = .segment(preview)
        case "step":
            let r = Receipt(segment: try c.decode(Int.self, forKey: .segment), taskId: try c.decode(String.self, forKey: .taskId),
                            step: try c.decode(Int.self, forKey: .step), steps: try c.decode(Int.self, forKey: .steps),
                            phase: try c.decode(Receipt.Phase.self, forKey: .phase), says: try c.decode(String.self, forKey: .says))
            guard !r.taskId.isEmpty, r.step >= 0, r.steps > 0 else { throw ProtocolError("a goal step receipt names its task and step") }
            event = .step(r)
        case "stopped":
            event = .stopped(Stop(segment: try GoalPlans.nullable(Int.self, c, .segment), step: try GoalPlans.nullable(Int.self, c, .step),
                                  reason: try c.decode(StopReason.self, forKey: .reason), says: try c.decode(String.self, forKey: .says),
                                  freshPlan: try GoalPlans.nullable(String.self, c, .freshPlan)))
        case "finished":
            let end = End(outcome: try c.decode(End.Outcome.self, forKey: .outcome), verified: try c.decode(Int.self, forKey: .verified),
                          skipped: try c.decode(Int.self, forKey: .skipped), left: try c.decode([String].self, forKey: .left),
                          says: try c.decode(String.self, forKey: .says))
            // protocol.ts's refine: done leaves nothing, and partial names what it leaves.
            guard (end.outcome == .done) == end.left.isEmpty || end.outcome == .handoff else {
                throw ProtocolError("done leaves nothing, and partial names what it leaves")
            }
            event = .finished(end)
        case let other:
            throw ProtocolError("unknown goalProgress event \(other)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.type, forKey: .type); try c.encode(Proto.version, forKey: .v)
        try c.encode(at, forKey: .at); try c.encode(goalId, forKey: .goalId); try c.encode(requestId, forKey: .requestId)
        switch event {
        case .segment(let p):
            try c.encode("segment", forKey: .event)
            try c.encode(p.segment, forKey: .segment); try c.encode(p.segments, forKey: .segments); try c.encode(p.reason, forKey: .reason)
            try c.encode(p.replaces, forKey: .replaces); try c.encode(p.digest, forKey: .digest); try c.encode(p.expires, forKey: .expires)
            var w = c.nestedContainer(keyedBy: PlaceKeys.self, forKey: .where)
            switch p.place {
            case .window(let app, let title): try w.encode("window", forKey: .kind); try w.encode(app, forKey: .app); try w.encode(title, forKey: .title)
            case .calendar(let name): try w.encode("calendar", forKey: .kind); try w.encode(name, forKey: .calendar)
            }
            var list = c.nestedUnkeyedContainer(forKey: .steps)
            for s in p.steps {
                var e = list.nestedContainer(keyedBy: StepKeys.self)
                try e.encode(s.index, forKey: .index); try e.encode(s.kind, forKey: .kind); try e.encode(s.says, forKey: .says)
                try e.encodeIfPresent(s.drafted, forKey: .drafted)
                if let file = s.file { try Self.encodeFile(file, into: &e) }
            }
            try c.encode(p.warnings, forKey: .warnings)
            try c.encodeIfPresent(p.page, forKey: .page)
        case .step(let r):
            try c.encode("step", forKey: .event)
            try c.encode(r.segment, forKey: .segment); try c.encode(r.taskId, forKey: .taskId); try c.encode(r.step, forKey: .step)
            try c.encode(r.steps, forKey: .steps); try c.encode(r.phase, forKey: .phase); try c.encode(r.says, forKey: .says)
        case .stopped(let s):
            try c.encode("stopped", forKey: .event)
            try c.encode(s.segment, forKey: .segment); try c.encode(s.step, forKey: .step); try c.encode(s.reason, forKey: .reason)
            try c.encode(s.says, forKey: .says); try c.encode(s.freshPlan, forKey: .freshPlan)
        case .finished(let e):
            try c.encode("finished", forKey: .event)
            try c.encode(e.outcome, forKey: .outcome); try c.encode(e.verified, forKey: .verified); try c.encode(e.skipped, forKey: .skipped)
            try c.encode(e.left, forKey: .left); try c.encode(e.says, forKey: .says)
        }
    }
}
