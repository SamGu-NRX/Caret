import AppKit
import ApplicationServices
import Carbon.HIToolbox
import Foundation

/// Reads the focused text field through the Accessibility API and turns it into
/// the snapshot the core expects.
///
/// Honesty is the design constraint. The core cannot see the screen: if we do
/// not report that a field is secure, it has no way to find out. So anything we
/// cannot actually determine is reported as a suppression or an unavailable
/// source, never as a confident `false`.
public final class FocusedTargetCapture {
    public struct Configuration: Sendable {
        /// Bundle identifiers Caret never reads. Password managers and the
        /// like belong here; the list is the app's, not baked in.
        public var excludedBundleIDs: Set<String>
        /// Clipboard reading stays off until the app explicitly turns it on.
        /// Until then every frame carries `clipboard: {"available": false}`,
        /// which the core treats as a real absence rather than empty text.
        public var clipboardEnabled: Bool
        public var nearbyTextLimit: Int

        public init(
            excludedBundleIDs: Set<String> = [],
            clipboardEnabled: Bool = false,
            nearbyTextLimit: Int = CoreLimits.nearbyTextUnits
        ) {
            self.excludedBundleIDs = excludedBundleIDs
            self.clipboardEnabled = clipboardEnabled
            self.nearbyTextLimit = nearbyTextLimit
        }
    }

    /// Why no snapshot was produced. Each case is a fact worth showing in
    /// diagnostics, not a generic failure.
    public enum Suppression: Equatable, Sendable {
        case accessibilityNotTrusted
        case noFocusedApplication
        case noFocusedElement
        /// The element is not a text surface we can reason about.
        case unsupportedRole(String)
        /// A secure field. Its value is never read.
        case secureField
        case appExcluded(String)
        /// The element exposes no readable value: a web view or a
        /// custom-drawn editor that does not implement `AXValue`.
        case valueUnreadable
        case selectionUnreadable
        /// An input method that can compose is active. Whether it is composing
        /// right now is not observable through the attributes we read, and a
        /// wrong answer here would let an edit land in the middle of a
        /// composition, so capture stops instead of guessing `false`.
        case imeCompositionUnobservable(inputSource: String)
        case windowUnavailable
        case nearbyTextUnbounded(NearbyTextWindow.Failure)
        /// The value did not change since the last snapshot, so there is
        /// nothing new for the core to evaluate.
        case unchanged(elementRevision: String)
    }

    public enum Outcome: Equatable, Sendable {
        case captured(InputSnapshot)
        case suppressed(Suppression)
    }

    public var configuration: Configuration

    private var revision = 0
    private var lastElementRevision: String?
    private let lock = NSLock()

    public init(configuration: Configuration = Configuration()) {
        self.configuration = configuration
    }

    /// Roles whose value and selected range we know how to read and, later, to
    /// edit. Anything else is reported by name rather than guessed at.
    private static let supportedRoles: Set<String> = [
        kAXTextFieldRole as String,
        kAXTextAreaRole as String,
        kAXComboBoxRole as String,
    ]

    /// Takes one reading. `skipUnchanged` lets a polling caller avoid sending
    /// the core a frame that names text it has already judged.
    public func capture(now: Date = Date(), skipUnchanged: Bool = true) -> Outcome {
        guard AXIsProcessTrusted() else { return .suppressed(.accessibilityNotTrusted) }
        guard let app = NSWorkspace.shared.frontmostApplication else {
            return .suppressed(.noFocusedApplication)
        }
        let bundleID = app.bundleIdentifier ?? ""
        if configuration.excludedBundleIDs.contains(bundleID) {
            return .suppressed(.appExcluded(bundleID))
        }

        let appElement = AXUIElementCreateApplication(app.processIdentifier)
        guard let element = Self.copyElement(appElement, kAXFocusedUIElementAttribute as CFString)
            ?? Self.copyElement(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute as CFString)
        else { return .suppressed(.noFocusedElement) }

        let role = Self.stringValue(element, kAXRoleAttribute as CFString) ?? ""
        let subrole = Self.stringValue(element, kAXSubroleAttribute as CFString) ?? ""
        if role == "AXSecureTextField" || subrole == "AXSecureTextField" {
            return .suppressed(.secureField)
        }
        guard Self.supportedRoles.contains(role) else { return .suppressed(.unsupportedRole(role)) }

        if let source = Self.composingInputSourceName() {
            return .suppressed(.imeCompositionUnobservable(inputSource: source))
        }

        guard let value = Self.stringValue(element, kAXValueAttribute as CFString) else {
            return .suppressed(.valueUnreadable)
        }
        guard let range = Self.selectedRange(element) else {
            return .suppressed(.selectionUnreadable)
        }
        guard let windowID = Self.windowIdentity(for: element, in: appElement) else {
            return .suppressed(.windowUnavailable)
        }

        let total = UTF16Text.length(value)
        let caret = min(max(0, range.location + range.length), total)
        let selection = TextSelection(
            start: min(max(0, range.location), total),
            end: min(max(0, range.location + range.length), total)
        )

        let elementRevision = UTF16Text.digest(value)
        lock.lock()
        let previous = lastElementRevision
        lock.unlock()
        if skipUnchanged, previous == elementRevision {
            return .suppressed(.unchanged(elementRevision: elementRevision))
        }

        let window: NearbyTextWindow
        switch NearbyTextWindow.around(
            value: value,
            caret: caret,
            selection: selection,
            limit: configuration.nearbyTextLimit
        ) {
        case .success(let built): window = built
        case .failure(let failure): return .suppressed(.nearbyTextUnbounded(failure))
        }

        lock.lock()
        revision += 1
        let currentRevision = revision
        lastElementRevision = elementRevision
        lock.unlock()

        let target = TargetIdentity(
            pid: app.processIdentifier,
            bundleID: bundleID,
            windowID: windowID,
            elementID: Self.elementIdentity(element, role: role),
            elementRevision: elementRevision
        )

        return .captured(InputSnapshot(
            revision: currentRevision,
            capturedAt: now,
            target: target,
            role: role,
            nearbyText: window.text,
            textOffset: window.offset,
            caret: caret,
            selection: selection,
            secure: false,
            imeComposing: false,
            appExcluded: false,
            valueLength: total
        ))
    }

    /// Clipboard stays unavailable until the app turns it on. There is no
    /// silent read.
    public func clipboardContext(now: Date = Date()) -> ClipboardContext {
        guard configuration.clipboardEnabled else { return .unavailable }
        guard let text = NSPasteboard.general.string(forType: .string) else { return .unavailable }
        guard UTF16Text.length(text) <= CoreLimits.clipboardUnits else {
            // Over the bound the core rejects the whole frame, and truncating
            // would misrepresent what the user copied.
            return .unavailable
        }
        return ClipboardContext(available: true, text: text, capturedAt: now)
    }

    public func permissions() -> Permissions {
        Permissions(accessibility: AXIsProcessTrusted())
    }

    /// Sources we did not supply, stated rather than omitted.
    public func sourceRecords() -> [SourceRecord] {
        [
            SourceRecord(
                name: "clipboard",
                available: configuration.clipboardEnabled,
                detail: configuration.clipboardEnabled ? "" : "not enabled in settings"
            )
        ]
    }

    // MARK: - Accessibility reads

    private static func stringValue(_ element: AXUIElement, _ attribute: CFString) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success, let value else { return nil }
        return value as? String
    }

    private static func copyElement(_ element: AXUIElement, _ attribute: CFString) -> AXUIElement? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success, let value,
              CFGetTypeID(value) == AXUIElementGetTypeID()
        else { return nil }
        return (value as! AXUIElement)
    }

    private static func selectedRange(_ element: AXUIElement) -> CFRange? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &value) == .success,
              let value, CFGetTypeID(value) == AXValueGetTypeID()
        else { return nil }
        var range = CFRange()
        guard AXValueGetValue(value as! AXValue, .cfRange, &range) else { return nil }
        return range
    }

    /// A stable per-element key. `AXIdentifier` when the app sets one;
    /// otherwise the role plus the element's position in its window, which is
    /// stable for as long as the field stays where it is. It only has to
    /// distinguish one field from another in the same window.
    private static func elementIdentity(_ element: AXUIElement, role: String) -> String {
        if let identifier = stringValue(element, kAXIdentifierAttribute as CFString), !identifier.isEmpty {
            return identifier
        }
        var position = CGPoint.zero
        var positionRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionRef) == .success,
           let positionRef, CFGetTypeID(positionRef) == AXValueGetTypeID() {
            AXValueGetValue(positionRef as! AXValue, .cgPoint, &position)
        }
        return "\(role)@\(Int(position.x)),\(Int(position.y))"
    }

    /// The focused element's window. `_AXUIElementGetWindow` would give the
    /// CGWindowID directly but is private, so the window is identified by its
    /// `AXIdentifier`, else its title, else its index among the app's windows.
    /// The core only compares this string for equality.
    private static func windowIdentity(for element: AXUIElement, in appElement: AXUIElement) -> String? {
        guard let window = copyElement(element, kAXWindowAttribute as CFString)
            ?? copyElement(element, kAXTopLevelUIElementAttribute as CFString)
            ?? copyElement(appElement, kAXFocusedWindowAttribute as CFString)
        else { return nil }
        if let identifier = stringValue(window, kAXIdentifierAttribute as CFString), !identifier.isEmpty {
            return identifier
        }
        if let title = stringValue(window, kAXTitleAttribute as CFString), !title.isEmpty {
            return "title:\(title)"
        }
        var windowsRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &windowsRef) == .success,
           let list = windowsRef as? [AXUIElement],
           let index = list.firstIndex(where: { CFEqual($0, window) }) {
            return "index:\(index)"
        }
        return "focused"
    }

    /// Names the active input source when it is one that composes (a Japanese
    /// or Chinese input mode, for example). `nil` means a plain keyboard
    /// layout, where no composition can be in progress.
    private static func composingInputSourceName() -> String? {
        guard let source = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue() else { return nil }
        guard let typePointer = TISGetInputSourceProperty(source, kTISPropertyInputSourceType) else { return nil }
        let type = Unmanaged<CFString>.fromOpaque(typePointer).takeUnretainedValue() as String
        guard type == (kTISTypeKeyboardInputMode as String) else { return nil }
        guard let idPointer = TISGetInputSourceProperty(source, kTISPropertyInputSourceID) else {
            return "unknown input mode"
        }
        return Unmanaged<CFString>.fromOpaque(idPointer).takeUnretainedValue() as String
    }
}
