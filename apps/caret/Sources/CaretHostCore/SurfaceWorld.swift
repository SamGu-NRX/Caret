import CaretScreenCore
import CoreGraphics
import Foundation

/// The window a field is in, as the window server numbers it and as its title reads.
public struct WindowIdentity: Equatable, Sendable {
    /// The window server's number (`CGWindowID`). Nil when it could not be read.
    public var number: UInt32?
    public var title: String?

    public init(number: UInt32? = nil, title: String? = nil) {
        self.number = number
        self.title = title
    }

    /// The window an offer's field is in, as the reader names it (`OfferField.window`). An empty
    /// title is no title: it would match every untitled window.
    public init(_ window: OfferWindow) {
        number = window.number.flatMap { UInt32(exactly: $0) }
        title = window.title.isEmpty ? nil : window.title
    }
}

/// The focused field of an app, read through Accessibility and reduced to plain values.
public struct FocusedField: Equatable, Sendable {
    public var identity: TargetIdentity
    public var value: String
    public var selection: UTF16Selection
    /// Global points, top-left origin. Nil when the element reports no frame.
    public var frame: CGRect?
    public var window: WindowIdentity?
    /// Names this read, so `SurfaceWorld.caret(of:)` and the drawing layer can find the element,
    /// font and style read with it.
    public var readID: UInt64

    public init(identity: TargetIdentity, value: String, selection: UTF16Selection, frame: CGRect?, window: WindowIdentity? = nil, readID: UInt64 = 0) {
        self.identity = identity
        self.value = value
        self.selection = selection
        self.frame = frame
        self.window = window
        self.readID = readID
    }
}

/// Where the caret of a field is, read only once the field is known to be the offer's.
public enum CaretRead: Equatable, Sendable {
    /// The ghost renderer could not take a snapshot of the field; nothing can be drawn in it.
    case noSnapshot
    /// Neither the field nor its frame and font give a caret.
    case noCaret
    /// Global points, top-left origin: as the field reports it, or derived from frame and font.
    case at(CGRect)
}

/// The window server's on-screen windows, front to back, for `SurfaceGate.check`.
public struct WindowStack: Equatable, Sendable {
    public var windows: [SurfaceGate.Window]
    public var ownPID: Int32
    /// Display frames, global top-left points.
    public var displays: [CGRect]

    public init(windows: [SurfaceGate.Window], ownPID: Int32, displays: [CGRect] = []) {
        self.windows = windows
        self.ownPID = ownPID
        self.displays = displays
    }
}

/// What `SurfaceMachine` asks of the system. Every answer is a plain value; CaretHost answers from
/// NSWorkspace, Accessibility and the window server, and tests answer from a fake screen. The
/// machine asks in the order the reads are cheapest and least intrusive: the frontmost app before
/// any Accessibility read of a background app.
public protocol SurfaceWorld: AnyObject {
    /// The pid may be offered into (`TargetPolicy`; a headless host checks the list only).
    func allows(pid: Int32) -> Bool
    /// NSWorkspace's frontmost app.
    var frontmostPID: Int32? { get }
    /// The app's focused field, for matching an offer to it.
    func focusedField(pid: Int32) -> FocusedField?
    /// The caret of a field just read, for drawing in it. Asked only of the offer's own field,
    /// because it reads the most (a renderer snapshot and the field's style).
    func caret(of field: FocusedField) -> CaretRead
    /// Only which element and window hold the app's focus, for rechecks.
    func focusedIdentity(pid: Int32) -> TargetIdentity?
    /// The frame of the app's focused element now (global top-left points), read at each check:
    /// a writing aid's decoration follows the focused field (`SurfaceGate.ringsField`).
    func focusedFrame(pid: Int32) -> CGRect?
    func windowStack() -> WindowStack
    /// The width of `text` in the font of the field read as `readID`.
    func textWidth(_ text: String, readID: UInt64) -> CGFloat
    /// The app's name for a line ("the app" when nil).
    func appName(pid: Int32) -> String?
    /// Whether `content`, drawn around the field at `field` with its caret at `caret`, has a spot
    /// that covers none of the app's own elements (`FieldPanelPlacement`, hit-tested by the host).
    /// Asked before an action line or pop-up is published, and again for its compact line.
    func panelIsClear(_ content: PanelContent, field: CGRect, caret: CGRect, pid: Int32) -> Bool
    var character: FigureCharacter { get }
    var reduceMotion: Bool { get }
}

/// Whether the focused field is the one an offer names.
///
/// The host cannot recompute the reader's element keys, so the field is matched by frame. A frame
/// alone cannot tell apart two windows of one app laid out the same (A5 review, finding 1), so when
/// both sides name the window, it must agree as well: by number when both have one, else by title.
/// When either side cannot name it, the frame decides alone.
public enum FieldMatch {
    public static func matches(declaredFrame: Frame?, declaredWindow: WindowIdentity?, focusedFrame: CGRect?, focusedWindow: WindowIdentity?) -> Bool {
        guard let declaredFrame, let focusedFrame else { return false }
        let focused = Frame(x: focusedFrame.minX, y: focusedFrame.minY, width: focusedFrame.width, height: focusedFrame.height)
        guard FillSelection.matches(declaredFrame, focused) else { return false }
        return sameWindow(declaredWindow, focusedWindow) ?? true
    }

    /// Nil when the two cannot be compared: neither a number on both sides nor a title on both.
    /// A title is compared only without numbers, because it changes as a document is edited.
    public static func sameWindow(_ a: WindowIdentity?, _ b: WindowIdentity?) -> Bool? {
        if let x = a?.number, let y = b?.number { return x == y }
        if let x = a?.title, let y = b?.title { return x == y }
        return nil
    }
}

/// An offer to show: one the helper sent, or one the debug socket injected.
public enum SurfaceIncoming: Equatable, Sendable {
    /// `window`: the window the helper names for the field, from the reader's window number and
    /// title (`OfferField.window`).
    case helper(HelperOffer, window: WindowIdentity?)
    case injected(SurfaceInjection)

    public var pid: Int32? {
        switch self {
        case .helper(let offer, _): return offer.pid
        case .injected(.alternatives(let pid, _, _)), .injected(.action(let pid, _)), .injected(.popup(let pid, _)): return pid
        case .injected(.helperLine): return nil
        }
    }

    public var offerKey: String? {
        switch self {
        case .helper(let offer, _): return offer.offerKey
        case .injected(.action(_, let line)): return line.offerKey
        case .injected(.popup(_, let popup)): return popup.offerKey
        case .injected: return nil
        }
    }

    /// The helper's key, for withdrawal. Injected offers are never withdrawn by the helper.
    public var helperKey: String? {
        if case .helper(let offer, _) = self { return offer.offerKey }
        return nil
    }

    /// Alternatives' texts, for the check that the widest fits in the field.
    public var candidates: [String] {
        switch self {
        case .helper(let offer, _): return offer.candidateTexts
        case .injected(.alternatives(_, let candidates, _)): return candidates
        case .injected: return []
        }
    }

    public var quoted: Bool {
        switch self {
        case .helper(let offer, _): return offer.quoted
        case .injected(.alternatives(_, _, let quoted)): return quoted
        case .injected: return false
        }
    }

    /// A helper offer is for one field; an injected one is for whatever field has focus.
    public func isFor(_ field: FocusedField) -> Bool {
        guard case .helper(let offer, let window) = self else { return true }
        return FieldMatch.matches(declaredFrame: offer.field.frame, declaredWindow: window, focusedFrame: field.frame, focusedWindow: field.window)
    }

    public func offer(for field: FocusedField, createdAt: Date) -> Offer? {
        let target = field.identity
        let caret = field.selection.start
        switch self {
        case .helper(let offer, _):
            return offer.offer(target: target, fieldValue: field.value, caretUTF16: caret, createdAt: createdAt)
        case .injected(.alternatives(_, let candidates, _)):
            return Offer(text: candidates[0], moreCandidates: Array(candidates.dropFirst()), source: .debug,
                         target: target, fieldValue: field.value, caretUTF16: caret, createdAt: createdAt, maxAgeSeconds: 120)
        case .injected(.action(_, let line)):
            return Offer(text: "", source: .debug, kind: .action(line), target: target,
                         fieldValue: field.value, caretUTF16: caret, createdAt: createdAt, maxAgeSeconds: 120)
        case .injected(.popup(_, let popup)):
            return Offer(text: "", source: .debug, kind: .popup(popup), target: target,
                         fieldValue: field.value, caretUTF16: caret, createdAt: createdAt, maxAgeSeconds: 120)
        case .injected(.helperLine):
            return nil
        }
    }
}
