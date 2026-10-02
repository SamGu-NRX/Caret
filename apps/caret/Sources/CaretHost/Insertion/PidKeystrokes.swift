import AppKit
import ApplicationServices
import AutocompleteCore
import CoreGraphics
import Foundation
import os
import TextInsertion

/// KeyType's keystroke seam, delivering to one process instead of the HID stream.
///
/// KeyType's own `CGEventKeystrokeSynthesizer` posts at `cghidEventTap`, which lands in whatever
/// app is frontmost when the event is processed, not necessarily the app the guard just checked.
/// Every event here goes through `CGEventPostToPid` to the target's pid, so a paste can only land
/// in the app whose field was reread. Selection writes go to the element itself, not to the
/// system-wide focused element.
///
/// Before each post, `stillTarget` is asked again; if it returns false (the target app quit, or
/// its pid is no longer allowed), the event is not sent.
final class PidKeystrokeSynthesizer: KeystrokeSynthesizing {
    private let pid: pid_t
    private let element: AXUIElement
    private let stillTarget: () -> Bool
    private let source = CGEventSource(stateID: .privateState)
    private(set) var refusedPosts = 0

    private static let keyV: CGKeyCode = 9
    private static let keyDelete: CGKeyCode = 51
    private static let keyTab: CGKeyCode = 48

    init(pid: pid_t, element: AXUIElement, stillTarget: @escaping () -> Bool) {
        self.pid = pid
        self.element = element
        self.stillTarget = stillTarget
        // The host's tap ignores events carrying this marker (KeyType ADR-039).
        source?.userData = SynthesizedEventMarker.userData
    }

    func paste() { post(Self.keyV, flags: .maskCommand) }

    func pasteAndMatchStyle() { post(Self.keyV, flags: [.maskCommand, .maskAlternate, .maskShift]) }

    func deleteBackward() { post(Self.keyDelete, flags: []) }

    /// A plain Tab, used after a fill so the form's own focus order moves to the next field.
    func tab() { post(Self.keyTab, flags: [], text: "\t") }

    func type(_ string: String) {
        guard !string.isEmpty else { return }
        post(0, flags: [], text: string)
    }

    func selectTextRange(location: Int, length: Int) -> Bool {
        AXRead.setRange(kAXSelectedTextRangeAttribute, location: location, length: length, on: element) == .success
    }

    private func post(_ keyCode: CGKeyCode, flags: CGEventFlags, text: String? = nil) {
        guard stillTarget() else {
            refusedPosts += 1
            return
        }
        for keyDown in [true, false] {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: keyDown) else { continue }
            event.flags = flags
            if let text {
                let units = Array(text.utf16)
                event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
            }
            event.postToPid(pid)
        }
    }
}

/// How each app takes a write, learned from what happened.
///
/// Some apps ignore a ⌘V posted to their pid: an AppKit app maps ⌘V to `paste:` through its main
/// menu, and an app with no Edit menu (caret-fixture is one) has nothing to map it to. For those,
/// the executor writes `AXSelectedText` on the field instead. Once an app has ignored a pid paste,
/// later writes go straight to AX, so the slow detection is paid once per app per launch.
final class WriteMethodTable: @unchecked Sendable {
    enum Method: String, Codable, Sendable {
        case pastePid
        case axSelectedText
    }

    private let learned = OSAllocatedUnfairLock(initialState: [String: Method]())

    func method(for app: String) -> Method {
        learned.withLock { $0[app] } ?? .pastePid
    }

    func record(_ method: Method, for app: String) {
        learned.withLock { $0[app] = method }
    }

    func snapshot() -> [String: String] {
        learned.withLock { $0.mapValues(\.rawValue) }
    }

    /// The key an app is learned under: its bundle identifier, or its executable name for a bare
    /// binary such as a fixture (whose pid changes on every launch).
    static func appKey(pid: pid_t) -> String {
        let app = NSRunningApplication(processIdentifier: pid)
        if let bundle = app?.bundleIdentifier { return bundle }
        if let name = app?.executableURL?.lastPathComponent { return "exe:\(name)" }
        return "pid:\(pid)"
    }
}
