// VM only: real HID-level keys and clicks for Q2's scenarios. BUILD-ORDER allows input that is not
// delivered to one pid only inside the rig VM, so this refuses to run unless rig-run started it (RIG_JOB set).
//
//   q2-key type <text>              each character as a key down/up with its Unicode string
//   q2-key key <name> [mods]        one named key; mods is a comma list of cmd,opt,shift,ctrl
//                                   names: tab return escape space delete left right up down home end
//                                   pageup pagedown, a single letter or digit
//   q2-key click <x> <y>            left click at global top-left-origin points
//   q2-key idle                     seconds since the last HID event (to check nothing else is typing)
import CoreGraphics
import Foundation

guard ProcessInfo.processInfo.environment["RIG_JOB"] != nil else {
    FileHandle.standardError.write(Data("q2-key: VM only (RIG_JOB unset)\n".utf8)); exit(2)
}

let named: [String: CGKeyCode] = [
    "tab": 48, "return": 36, "escape": 53, "space": 49, "delete": 51, "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
]
// ANSI key codes for letters and digits, so shortcuts like cmd-z and cmd-1 reach menus as real keys.
let letters: [Character: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
    "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29,
    "=": 24, "-": 27, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46, ".": 47, ",": 43, "/": 44,
]

func flags(_ s: String) -> CGEventFlags {
    var f: CGEventFlags = []
    for m in s.split(separator: ",") {
        switch m {
        case "cmd": f.insert(.maskCommand)
        case "opt": f.insert(.maskAlternate)
        case "shift": f.insert(.maskShift)
        case "ctrl": f.insert(.maskControl)
        default: FileHandle.standardError.write(Data("q2-key: unknown modifier \(m)\n".utf8)); exit(2)
        }
    }
    return f
}

func post(_ code: CGKeyCode, _ text: String?, _ f: CGEventFlags = []) {
    for down in [true, false] {
        guard let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) else { continue }
        if let text { let u = Array(text.utf16); e.keyboardSetUnicodeString(stringLength: u.count, unicodeString: u) }
        e.flags = f
        e.post(tap: .cghidEventTap)
        usleep(18_000)
    }
    usleep(35_000)
}

let a = CommandLine.arguments
switch a.count > 1 ? a[1] : "" {
case "type":
    for c in (a.count > 2 ? a[2] : "") {
        if c == "\n" { post(36, nil) } else { post(letters[Character(c.lowercased())] ?? 0, String(c)) }
    }
case "key":
    guard a.count > 2 else { exit(2) }
    let name = a[2].lowercased(), f = flags(a.count > 3 ? a[3] : "")
    if let code = named[name] { post(code, nil, f) }
    else if name.count == 1, let code = letters[Character(name)] { post(code, f.isEmpty ? name : nil, f) }
    else { FileHandle.standardError.write(Data("q2-key: unknown key \(name)\n".utf8)); exit(2) }
case "click":
    guard a.count > 3, let x = Double(a[2]), let y = Double(a[3]) else { exit(2) }
    let p = CGPoint(x: x, y: y)
    for t in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
        CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
        usleep(40_000)
    }
case "idle":
    print(CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: CGEventType(rawValue: ~0)!))
default:
    FileHandle.standardError.write(Data("usage: q2-key type <text> | key <name> [mods] | click <x> <y> | idle\n".utf8)); exit(2)
}
