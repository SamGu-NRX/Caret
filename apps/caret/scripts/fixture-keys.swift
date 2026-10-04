// Types into a fixture window the way a keyboard does, for host acceptance tests.
//
// The host is a system-wide keyboard companion: it reads the focused field and owns a session
// event tap. cua-driver's background text route writes through AX and posts keys per process, so
// neither reaches that tap. This helper posts at the HID level instead, which is what a real
// keyboard does, and refuses every key unless the target pid owns both the frontmost app and the
// focused element. It can therefore never type into a window the test did not create.
//
// Build: swiftc -O fixture-keys.swift -o ../.build/fixture-keys
// Usage: fixture-keys <pid> type <text> [interval_ms]
//        fixture-keys <pid> key tab|left|right|down|space|delete|cmd-2|escape|cmd-z|opt-right [count]
//        fixture-keys <pid> check

import ApplicationServices
import CoreGraphics
import Foundation

/// The pid of the app that receives keyboard input: LaunchServices' front application. Window
/// order is not enough: an app can own the frontmost window without being active, and then HID
/// keys go to the active app instead (seen on 2026-10-02, when keys meant for a fixture reached
/// another app).
func activeAppPID() -> pid_t? {
    func run(_ args: [String]) -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/lsappinfo")
        process.arguments = args
        let pipe = Pipe()
        process.standardOutput = pipe
        do { try process.run() } catch { return "" }
        process.waitUntilExit()
        return String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    }
    let asn = run(["front"]).trimmingCharacters(in: .whitespacesAndNewlines)
    guard !asn.isEmpty else { return nil }
    let info = run(["info", "-only", "pid", asn])
    guard let value = info.split(separator: "=").last?.trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
    return pid_t(value)
}

/// The active app's pid and the pid owning that app's focused element.
func focusedPIDs() -> (app: pid_t?, element: pid_t?) {
    guard let front = activeAppPID() else { return (nil, nil) }
    let app = AXUIElementCreateApplication(front)
    for _ in 0..<5 {
        var value: CFTypeRef?
        if AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &value) == .success, let value,
           CFGetTypeID(value) == AXUIElementGetTypeID() {
            var pid: pid_t = 0
            let element = AXUIElementGetPid(unsafeBitCast(value, to: AXUIElement.self), &pid) == .success ? pid : nil
            return (front, element)
        }
        usleep(20_000)
    }
    return (front, nil)
}

/// Exits 3 when the target lost focus, after printing how many units were already sent so a
/// caller can re-focus and resume.
func requireTarget(_ target: pid_t, sent: Int = 0) {
    let focus = focusedPIDs()
    guard focus.app == target, focus.element == target else {
        print("sent \(sent)")
        FileHandle.standardError.write(Data("refused: focus is app=\(focus.app.map(String.init) ?? "nil") element=\(focus.element.map(String.init) ?? "nil"), not \(target)\n".utf8))
        exit(3)
    }
}

func post(keyCode: CGKeyCode, text: String?, flags: CGEventFlags = []) {
    let source = CGEventSource(stateID: .hidSystemState)
    for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: down) else { continue }
        event.flags = flags
        if let text {
            let units = Array(text.utf16)
            event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        }
        event.post(tap: .cghidEventTap)
        usleep(4_000)
    }
}

let args = CommandLine.arguments
guard args.count >= 3, let target = pid_t(args[1]) else {
    FileHandle.standardError.write(Data("usage: fixture-keys <pid> type|key|check ...\n".utf8))
    exit(2)
}

switch args[2] {
case "check":
    requireTarget(target)
    print("ok")
case "type":
    guard args.count >= 4 else { exit(2) }
    let interval = args.count >= 5 ? UInt32(args[4]) ?? 120 : 120
    for (sent, character) in args[3].enumerated() {
        requireTarget(target, sent: sent)
        let text = String(character)
        post(keyCode: text == " " ? 49 : 0, text: text)
        usleep(interval * 1_000)
    }
    print("sent \(args[3].count)")
case "key":
    guard args.count >= 4 else { exit(2) }
    let count = args.count >= 5 ? Int(args[4]) ?? 1 : 1
    let codes: [String: (CGKeyCode, String?, CGEventFlags)] = [
        "tab": (48, "\t", []), "left": (123, nil, []), "right": (124, nil, []), "down": (125, nil, []),
        "space": (49, " ", []), "delete": (51, nil, []), "cmd-2": (19, nil, .maskCommand),
        "escape": (53, "\u{1b}", []), "cmd-z": (6, "z", .maskCommand), "opt-right": (124, nil, .maskAlternate),
    ]
    guard let (code, text, flags) = codes[args[3]] else { exit(2) }
    for sent in 0..<count {
        requireTarget(target, sent: sent)
        post(keyCode: code, text: text, flags: flags)
        usleep(30_000)
    }
default:
    exit(2)
}
