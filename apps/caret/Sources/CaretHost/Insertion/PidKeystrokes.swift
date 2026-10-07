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
/// Before each post and each selection change, `stillTarget` is asked again; if it returns false
/// (the claim's authorization was revoked, the target app quit, its pid is no longer allowed, or
/// another element took focus), nothing is sent.
final class PidKeystrokeSynthesizer: KeystrokeSynthesizing {
    private let pid: pid_t
    private let element: AXUIElement
    private let stillTarget: () -> Bool
    private let source = CGEventSource(stateID: .privateState)
    private(set) var refusedPosts = 0
    /// ⌘V key-downs actually posted: only these can have put text anywhere.
    private(set) var pastesPosted = 0
    /// Every key-down posted, typed text and deletes included: none means the app was sent nothing.
    private(set) var keysPosted = 0

    private static let keyV: CGKeyCode = 9
    private static let keyDelete: CGKeyCode = 51
    private static let keyTab: CGKeyCode = 48
    private static let keyZ: CGKeyCode = 6

    init(pid: pid_t, element: AXUIElement, stillTarget: @escaping () -> Bool) {
        self.pid = pid
        self.element = element
        self.stillTarget = stillTarget
        // The host's tap ignores events carrying this marker (KeyType ADR-039).
        source?.userData = SynthesizedEventMarker.userData
    }

    func paste() {
        if post(Self.keyV, flags: .maskCommand) { pastesPosted += 1 }
    }

    func pasteAndMatchStyle() {
        if post(Self.keyV, flags: [.maskCommand, .maskAlternate, .maskShift]) { pastesPosted += 1 }
    }

    func deleteBackward() { post(Self.keyDelete, flags: []) }

    /// A plain Tab, used after a fill so the form's own focus order moves to the next field.
    func tab() { post(Self.keyTab, flags: [], text: "\t") }

    /// One ⌘Z: the app's own Undo, for a writing fix's toast where it is proven (`NativeUndo`).
    /// Marked like every key here, so the host's tap lets it through to the app untouched. True
    /// when the key-down was posted.
    func undo() -> Bool { post(Self.keyZ, flags: .maskCommand) }

    func type(_ string: String) {
        guard !string.isEmpty else { return }
        post(0, flags: [], text: string)
    }

    /// A selection change is a write to the app too: it is made only while the target holds.
    func selectTextRange(location: Int, length: Int) -> Bool {
        guard stillTarget() else {
            refusedPosts += 1
            return false
        }
        return AXRead.setRange(kAXSelectedTextRangeAttribute, location: location, length: length, on: element) == .success
    }

    /// The target is asked again immediately before the key-down, which is what the app acts on.
    /// The key-up of a key-down already posted is sent whatever the answer: it changes nothing in the
    /// app, and leaving the key down would. That is the one post made without the check.
    /// True when the key-down was posted.
    @discardableResult
    private func post(_ keyCode: CGKeyCode, flags: CGEventFlags, text: String? = nil) -> Bool {
        func event(_ keyDown: Bool) -> CGEvent? {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: keyDown) else { return nil }
            event.flags = flags
            if let text {
                let units = Array(text.utf16)
                event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
            }
            return event
        }
        guard let down = event(true), let up = event(false) else { return false }
        guard stillTarget() else {
            refusedPosts += 1
            return false
        }
        down.postToPid(pid)
        up.postToPid(pid)
        keysPosted += 1
        return true
    }
}

/// How each app takes a write, learned from what happened.
///
/// `AXSelectedText` on the field itself comes first (A17): it can land only in that element and
/// leaves the clipboard alone. Some apps refuse it or accept it and change nothing; those get a ⌘V
/// posted to their pid through the reconciled pasteboard, and once an app has been seen to do so,
/// later writes paste straight away, so the slow detection is paid once per app per launch.
final class WriteMethodTable: @unchecked Sendable {
    enum Method: String, Codable, Sendable {
        case pastePid
        case axSelectedText
    }

    private let learned = OSAllocatedUnfairLock(initialState: [String: Method]())

    func method(for app: String) -> Method {
        learned.withLock { $0[app] } ?? .axSelectedText
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
