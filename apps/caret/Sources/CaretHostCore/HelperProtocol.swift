import CaretScreenCore
import Foundation

/// What the host does with one line from the helper's socket.
///
/// The wire types are the screen track's (`CaretScreenCore`, mirroring `helper/src/protocol.ts`).
/// The host acts on `fillProposal`, `error`, the broadcast `activity` and the `activityReply` to
/// its own request, the offers (`alternatives`, `action`, `popup`) and their withdrawal,
/// `taskProgress`, which ends the working line of an accepted offer, and `skillOffer`. Anything else the helper sends
/// is named and counted rather than treated as a broken connection, so a helper that adds message
/// types does not disconnect an older host.
public enum HelperInbound: Equatable, Sendable {
    case fillProposal(FillProposal)
    case error(HelperError)
    case activity(Activity)
    case activityReply(ActivityReply)
    case alternatives(OfferAlternatives)
    case action(OfferAction)
    case popup(OfferPopup)
    /// Reason `reoffered` carries `replacedBy`, the key of the offer that replaces it.
    case offerWithdrawn(OfferWithdrawn)
    case taskProgress(TaskProgress)
    /// The answer to this host's `firstLook` (`FirstLook.swift`), the host's own contract until
    /// the helper's schema has it.
    case firstLookReply(FirstLookReply)
    /// The answer to this host's `memoryRequest` (`HelperMemory`), to this connection only.
    case memoryReply(HelperMemory.Reply)
    /// The answer to this host's `planRequest` (`AskCaret`), to this connection only.
    case planProposal(PlanProposal)
    /// B19: keep a routine as a skill, or let a skill run without a Tab. Asked after a run the
    /// user took; the host shows it with that run's line and answers with `skillAnswer`.
    case skillOffer(SkillOffer)
    /// M1: the noticed facts an offer or plan was built from, right after it.
    case memoryProvenance(MemoryProvenance)
    /// M1: the answer to this host's `memoryDocumentRequest`, to this connection only.
    case memoryDocumentReply(MemoryDocumentReply)
    /// D2-02: the router's decision for a field; ghost text and the writing line follow it (H6).
    case routeDecision(RouteDecision)
    /// B29: an Ask came back as a question with choices, to this connection only.
    case askQuestion(AskQuestion)
    /// W2: whether Caret can see a browser's pages (`PageSight`).
    case pageEngine(PageEngineState)
    /// H5: the answer to this host's `fileConfirm`, to this connection only.
    case fileConfirmReply(FileConfirmReply)
    /// H8: the helper's model spend since it started (`HelperSpend`), shown on the debug socket.
    case spend(HelperSpend)
    /// H10: the page field the user is in, which the host cannot read itself (`PageFocusBook`).
    case pageField(PageField)
    /// H11 (H9's types): a goal's preview, a step's receipt, its stop or its end, to a host whose hello
    /// names `goalPlans`. The page task panel shows a page goal (`PageTaskMachine`).
    case goalProgress(GoalProgress)
    /// L1: words from the host's local model. This host names no `localModel`, so it answers each
    /// one `unavailable` (`LocalText`).
    case localTextRequest(LocalTextRequest)
    /// S1: the user left a prose field they typed; Caret may keep their words.
    case answerSaveOffer(AnswerSaveOffer)
    /// S1: what became of this host's `answerSave`.
    case answerSaveReply(AnswerSaveReply)
    /// H13: what became of this host's `pageInsert` (`PageInlineMachine`).
    case pageInsertReply(PageInsertReply)
    /// P3, H14: Caret attached a file the user confirmed and may keep it for the same question (`FileSaveMachine`).
    case fileSaveOffer(FileSaveOffer)
    /// P3, H14: what became of this host's `fileSave`.
    case fileSaveReply(FileSaveReply)
    /// H14: the files the user kept, for the memory window (`SavedFilesBook`).
    case savedFilesReply(SavedFilesReply)
    /// A valid protocol message that is not addressed to consumers (reader traffic, or our own
    /// requests echoed back).
    case notForConsumer(type: String)
    /// A `type` this host does not know. Newer helpers may send these.
    case unknown(type: String)

    /// The message's wire `type`, for counters.
    public var typeName: String {
        switch self {
        case .fillProposal: return FillProposal.type
        case .error: return HelperError.type
        case .activity: return Activity.type
        case .activityReply: return ActivityReply.type
        case .alternatives: return OfferAlternatives.type
        case .action: return OfferAction.type
        case .popup: return OfferPopup.type
        case .offerWithdrawn: return OfferWithdrawn.type
        case .taskProgress: return TaskProgress.type
        case .firstLookReply: return FirstLookReply.type
        case .memoryReply: return HelperMemory.Reply.type
        case .planProposal: return PlanProposal.type
        case .skillOffer: return SkillOffer.type
        case .memoryProvenance: return MemoryProvenance.type
        case .memoryDocumentReply: return MemoryDocumentReply.type
        case .routeDecision: return RouteDecision.type
        case .askQuestion: return AskQuestion.type
        case .pageEngine: return PageEngineState.type
        case .fileConfirmReply: return FileConfirmReply.type
        case .spend: return HelperSpend.type
        case .pageField: return PageField.type
        case .goalProgress: return GoalProgress.type
        case .localTextRequest: return LocalTextRequest.type
        case .answerSaveOffer: return AnswerSaveOffer.type
        case .answerSaveReply: return AnswerSaveReply.type
        case .pageInsertReply: return PageInsertReply.type
        case .fileSaveOffer: return FileSaveOffer.type
        case .fileSaveReply: return FileSaveReply.type
        case .savedFilesReply: return SavedFilesReply.type
        case .notForConsumer(let type), .unknown(let type): return type
        }
    }

    public static func decode(_ line: Data) throws -> HelperInbound {
        let envelope = try JSONDecoder().decode(EnvelopeProbe.self, from: line)
        guard envelope.v == Proto.version else {
            throw ProtocolError("unsupported protocol version \(envelope.v) for \(envelope.type)")
        }
        switch envelope.type {
        case FillProposal.type, HelperError.type, Activity.type, ActivityReply.type, OfferAlternatives.type,
             OfferAction.type, OfferPopup.type, OfferWithdrawn.type, TaskProgress.type:
            switch try JSONDecoder().decode(Message.self, from: line) {
            case .fillProposal(let proposal): return .fillProposal(proposal)
            case .error(let error): return .error(error)
            case .activity(let activity): return .activity(activity)
            case .activityReply(let reply): return .activityReply(reply)
            case .alternatives(let offer): return .alternatives(offer)
            case .action(let offer): return .action(offer)
            case .popup(let offer): return .popup(offer)
            case .offerWithdrawn(let withdrawn): return .offerWithdrawn(withdrawn)
            case .taskProgress(let progress): return .taskProgress(progress)
            default: return .notForConsumer(type: envelope.type)
            }
        case Hello.type, FillRequest.type, "snapshot", "focus", "appSwitch", "windowClosed", "pasteboard",
             "readerCommand", "verbResult", "userInput", "taskControl", "activityRequest", OfferAccept.type, OfferStop.type, GateSettings.type,
             // The helper's act and calendar grants go to the reader only (B15, B16); a consumer never acts on one.
             ActGrant.type, ActRevoke.type, CalendarGrant.type, PlanRequest.type,
             // The reader's report of a press the user made (B20, B21): the helper's to learn from.
             UserPress.type,
             // The helper's proof to the reader that it holds the launch secret (B23).
             HelperAuth.type:
            // Validated, so a malformed line is still counted as undecodable.
            _ = try JSONDecoder().decode(Message.self, from: line)
            return .notForConsumer(type: envelope.type)
        case FillResult.type, FirstLookRequest.type, HelperMemory.Request.type, MemoryNotRight.type, MemoryDocumentRequest.type:
            return .notForConsumer(type: envelope.type)
        case MemoryProvenance.type:
            return .memoryProvenance(try MemoryProvenance.decode(line))
        case MemoryDocumentReply.type:
            return .memoryDocumentReply(try MemoryDocumentReply.decode(line))
        case FileConfirmReply.type:
            return .fileConfirmReply(try JSONDecoder().decode(FileConfirmReply.self, from: line))
        case FileConfirm.type:
            // The host's own confirmation, echoed back; not for a consumer.
            return .notForConsumer(type: envelope.type)
        case PageEngineState.type:
            return .pageEngine(try JSONDecoder().decode(PageEngineState.self, from: line))
        case HelperSpend.type:
            return .spend(try JSONDecoder().decode(HelperSpend.self, from: line))
        case PageField.type:
            return .pageField(try JSONDecoder().decode(PageField.self, from: line))
        case RouteDecision.type:
            return .routeDecision(try JSONDecoder().decode(RouteDecision.self, from: line))
        case RoutingContext.type:
            // The host's own context, echoed back; validated so a malformed line is still counted.
            _ = try JSONDecoder().decode(RoutingContext.self, from: line)
            return .notForConsumer(type: envelope.type)
        case AskQuestion.type:
            return .askQuestion(try JSONDecoder().decode(AskQuestion.self, from: line))
        case AskAnswer.type:
            _ = try JSONDecoder().decode(AskAnswer.self, from: line)
            return .notForConsumer(type: envelope.type)
        case FillAllRequest.type:
            _ = try JSONDecoder().decode(FillAllRequest.self, from: line)
            return .notForConsumer(type: envelope.type)
        case FirstLookReply.type:
            return .firstLookReply(try FirstLookReply.decode(line))
        case HelperMemory.Reply.type:
            return .memoryReply(try HelperMemory.Reply.decode(line))
        case PlanProposal.type:
            return .planProposal(try JSONDecoder().decode(PlanProposal.self, from: line))
        case SkillOffer.type:
            return .skillOffer(try JSONDecoder().decode(SkillOffer.self, from: line))
        case GoalProgress.type:
            return .goalProgress(try JSONDecoder().decode(GoalProgress.self, from: line))
        case LocalTextRequest.type:
            return .localTextRequest(try JSONDecoder().decode(LocalTextRequest.self, from: line))
        case AnswerSaveOffer.type:
            return .answerSaveOffer(try JSONDecoder().decode(AnswerSaveOffer.self, from: line))
        case AnswerSaveReply.type:
            return .answerSaveReply(try JSONDecoder().decode(AnswerSaveReply.self, from: line))
        case PageInsertReply.type:
            return .pageInsertReply(try JSONDecoder().decode(PageInsertReply.self, from: line))
        case FileSaveOffer.type:
            return .fileSaveOffer(try JSONDecoder().decode(FileSaveOffer.self, from: line))
        case FileSaveReply.type:
            return .fileSaveReply(try JSONDecoder().decode(FileSaveReply.self, from: line))
        case SavedFilesReply.type:
            return .savedFilesReply(try JSONDecoder().decode(SavedFilesReply.self, from: line))
        case FileSave.type:
            _ = try JSONDecoder().decode(FileSave.self, from: line)
            return .notForConsumer(type: envelope.type)
        case SavedFilesRequest.type:
            _ = try JSONDecoder().decode(SavedFilesRequest.self, from: line)
            return .notForConsumer(type: envelope.type)
        // The host's own goal, local-text and save messages, echoed back; validated so a malformed line is still counted.
        case GoalRequest.type:
            _ = try JSONDecoder().decode(GoalRequest.self, from: line)
            return .notForConsumer(type: envelope.type)
        case PageInsert.type:
            _ = try JSONDecoder().decode(PageInsert.self, from: line)
            return .notForConsumer(type: envelope.type)
        case GoalAccept.type:
            _ = try JSONDecoder().decode(GoalAccept.self, from: line)
            return .notForConsumer(type: envelope.type)
        case GoalEdit.type:
            _ = try JSONDecoder().decode(GoalEdit.self, from: line)
            return .notForConsumer(type: envelope.type)
        case LocalTextReply.type:
            _ = try JSONDecoder().decode(LocalTextReply.self, from: line)
            return .notForConsumer(type: envelope.type)
        case AnswerSave.type:
            _ = try JSONDecoder().decode(AnswerSave.self, from: line)
            return .notForConsumer(type: envelope.type)
        case SkillAnswer.type:
            // The host's own answer, echoed back; validated so a malformed line is still counted.
            _ = try JSONDecoder().decode(SkillAnswer.self, from: line)
            return .notForConsumer(type: envelope.type)
        default:
            return .unknown(type: envelope.type)
        }
    }

    private struct EnvelopeProbe: Decodable {
        let type: String
        let v: Int
    }
}

// `FillResult` (host to helper: what became of one field of a fill proposal after Tab or ⌘Z) is
// the screen track's type in CaretScreenCore since v2/screen added it to the helper's schema; the
// host's own copy was removed so the two cannot drift or collide.

/// Splits a byte stream into NDJSON lines. A partial line stays buffered until its newline
/// arrives; an over-long line is dropped whole and reported, so one bad message cannot grow the
/// buffer without bound or desynchronize the lines after it.
public struct LineFramer: Sendable {
    public let maxLineBytes: Int
    private var buffer = Data()
    private var discarding = false

    public init(maxLineBytes: Int = 4 * 1024 * 1024) {
        self.maxLineBytes = maxLineBytes
    }

    public enum Item: Equatable, Sendable {
        case line(Data)
        case oversized
    }

    public mutating func append(_ chunk: Data) -> [Item] {
        var out: [Item] = []
        var rest = chunk[...]
        while let newline = rest.firstIndex(of: 0x0A) {
            let piece = rest[rest.startIndex..<newline]
            rest = rest[rest.index(after: newline)...]
            if discarding {
                discarding = false
                buffer.removeAll()
                continue
            }
            buffer.append(contentsOf: piece)
            if buffer.count > maxLineBytes {
                out.append(.oversized)
            } else if !buffer.allSatisfy({ $0 == 0x20 || $0 == 0x0D || $0 == 0x09 }) {
                out.append(.line(buffer))
            }
            buffer.removeAll()
        }
        if !discarding {
            buffer.append(contentsOf: rest)
            if buffer.count > maxLineBytes {
                out.append(.oversized)
                buffer.removeAll()
                discarding = true
            }
        }
        return out
    }
}

/// The host's hello to the helper. `host: true` (B23): only the host app's session counts as "host
/// connected", which a skill needs before it runs on its own, and the helper binds the work the host
/// accepts to this session. `capabilities` names what this host understands:
/// - `memoryDocuments` (M1): noticed facts as noticed, with provenance, "Not right" and the documents.
/// - `fillAll` (D2-04): ⌘1 on a field's fill sends `fillAll` for the whole form.
/// - `askChoices` (B29): an Ask may come back as a question with choices, answered with `askAnswer`.
/// - `goalPlans` (D2-06, H11): an Ask about a page comes back as a page goal, previewed in the panel at the
///   form one segment at a time; each Tab sends `goalAccept` for the segment showing (`PageTaskMachine`).
/// - `savedAnswers` (S1, H11): the host shows a saved answer whole before inserting it and offers to save one
///   on ⌘1 only (`SavedAnswers`, `AnswerSaveMachine`).
/// - `pageText` (H13): the helper sends the text around a page field's caret and the caret, for inline text, and
///   takes `pageInsert`; this host never logs, stores or shows that text on its debug socket (`PageInline`).
/// - `goalFiles` (P3, H14): a page goal's file controls come as attach rows the user fills with a file they choose or
///   confirm (⌘2 or a click; never Tab alone), sent as `goalAccept.confirmedFile`; the host shows `fileSaveOffer` and
///   lists kept files. Declared only when the host has both the file chooser and the save line wired
///   (`PageTaskMachine.filesWired`); a helper then never sends this host an attach row it cannot show.
/// - `valueChecks` (W2, H1): the host decodes a fill field withheld as `notExact` or `unverified`, and offers nothing
///   for it, as for every withheld field (`FillSelection.Skip.withheld`). A host without it is sent `wrongKind`.
/// - `askScope` (I2, H1): the host decodes `outOfScope` as a withheld fill field and as a plan refusal, which it says
///   in the helper's words, or `AskCopy`'s for a helper that sends none. A host without it is sent `wrongKind` and
///   `unknownWindow` in its place.
/// - `routing` (D2-02, H6): only while the user's setting "Caret decides when to help" is on. The
///   helper then sends route decisions, and its offers wait for them.
/// A helper from before any of these ignores the names it does not know (its hello schema is not strict).
public enum HostHello {
    public static let fillAllCapability = "fillAll"
    public static let askChoicesCapability = "askChoices"
    /// protocol.ts VALUE_CHECKS_CAPABILITY.
    public static let valueChecksCapability = "valueChecks"
    /// protocol.ts ASK_SCOPE_CAPABILITY.
    public static let askScopeCapability = "askScope"

    public static func capabilities(routing: Bool, goalFiles: Bool = false) -> [String] {
        // H11: goalPlans, so an Ask about a page comes back as a page goal for the panel at the form; savedAnswers,
        // since the host shows an answer whole before inserting it (`SavedAnswers`), offers to save one on ⌘1 only,
        // and decodes the answers document. No localModel: this host serves no local text (`LocalText`).
        // H13: pageText, so a page field arrives with the text around its caret for inline text.
        // H1: valueChecks and askScope, since CaretScreenCore's FillWithheld and PlanProposal.ErrorCode decode the
        // reasons they add; without them the helper would send this host the older, less exact reasons.
        [MemoryDocs.capability, fillAllCapability, askChoicesCapability, HelperSpend.capability, GoalPlans.capability, SavedAnswers.capability, PageInline.capability,
         valueChecksCapability, askScopeCapability]
            + (goalFiles ? [GoalFiles.capability] : [])
            + (routing ? [Routing.capability] : [])
    }

    public static func make(pid: Int, routing: Bool, goalFiles: Bool = false) -> Message {
        Message(hello: Hello(role: .consumer, mode: .live, pid: pid, version: "caret-host 0.2.0", host: true), capabilities: capabilities(routing: routing, goalFiles: goalFiles))
    }

    /// CaretScreenCore's `Hello` with the capabilities beside it; that mirror has no such key.
    public struct Message: Encodable, Equatable, Sendable {
        public var hello: Hello
        public var capabilities: [String]

        enum CodingKeys: String, CodingKey { case capabilities }

        public func encode(to encoder: Encoder) throws {
            try hello.encode(to: encoder)
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(capabilities, forKey: .capabilities)
        }
    }
}
