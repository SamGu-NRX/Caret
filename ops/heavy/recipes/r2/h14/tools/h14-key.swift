// VM only: real HID-level keys and clicks for H14 (H13's h13-key, plus `move`). BUILD-ORDER allows input that is not
// delivered to one pid only inside the rig VM, so this refuses to run unless rig-run started it (RIG_JOB set).
//
//   h14-key type <text>              each character as a key down/up with its Unicode string
//   h14-key key <name> [mods]        one named key; mods is a comma list of cmd,opt,shift,ctrl
//                                    names: tab return escape space delete left right up down home end
//                                    pageup pagedown, a single letter or digit
//   h14-key click <x> <y>            left click at global top-left-origin points
//   h14-key move <x> <y>             the pointer to that point, no click. H14: the page task panel passes the pointer
//                                    through until a mouse-moved event puts it over the panel's content
//                                    (HostedPanel.pointerMoved), so the driver moves first and clicks after a pause.
//   h14-key idle                     seconds since the last HID event
//   h14-key serve                    one command per stdin line, "ok" on stdout after each, so the driver times keys
//                                    without a process launch per key:
//                                      c <unicode scalar, decimal>   one character, as `type` posts it
//                                      k <name> [mods]               as `key`
//                                      m <x> <y>                     as `click`
//                                      v <x> <y>                     as `move`
import CoreGraphics
import Foundation

guard ProcessInfo.processInfo.environment["RIG_JOB"] != nil else {
    FileHandle.standardError.write(Data("h14-key: VM only (RIG_JOB unset)\n".utf8)); exit(2)
}

let named: [String: CGKeyCode] = [
    "tab": 48, "return": 36, "escape": 53, "space": 49, "delete": 51, "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
]
// ANSI key codes for letters and digits, so shortcuts like cmd-z reach menus as real keys. H13: space has its own code
// (q2-key sent it as key code 0 with a " " string).
let letters: [Character: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
    "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29,
    "=": 24, "-": 27, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46, ".": 47, ",": 43, "/": 44,
    " ": 49,
]

enum Bad: Error { case usage(String) }

func flags(_ s: String) throws -> CGEventFlags {
    var f: CGEventFlags = []
    for m in s.split(separator: ",") {
        switch m {
        case "cmd": f.insert(.maskCommand)
        case "opt": f.insert(.maskAlternate)
        case "shift": f.insert(.maskShift)
        case "ctrl": f.insert(.maskControl)
        default: throw Bad.usage("unknown modifier \(m)")
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

func char(_ c: Character) {
    if c == "\n" { post(36, nil) } else { post(letters[Character(c.lowercased())] ?? 0, String(c)) }
}

func key(_ rawName: String, _ mods: String) throws {
    let name = rawName.lowercased(), f = try flags(mods)
    if let code = named[name] { post(code, nil, f) }
    else if name.count == 1, let code = letters[Character(name)] { post(code, f.isEmpty ? name : nil, f) }
    else { throw Bad.usage("unknown key \(name)") }
}

func click(_ x: Double, _ y: Double) {
    let p = CGPoint(x: x, y: y)
    for t in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
        CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
        usleep(40_000)
    }
}

func move(_ x: Double, _ y: Double) {
    CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)?.post(tap: .cghidEventTap)
    usleep(40_000)
}

func serve() {
    setvbuf(stdout, nil, _IOLBF, 0)
    while let line = readLine() {
        let w = line.split(separator: " ").map(String.init)
        do {
            switch w.first {
            case "c":
                guard w.count == 2, let n = UInt32(w[1]), let s = Unicode.Scalar(n) else { throw Bad.usage("c <scalar>") }
                char(Character(s))
            case "k":
                guard w.count >= 2 else { throw Bad.usage("k <name> [mods]") }
                try key(w[1], w.count > 2 ? w[2] : "")
            case "m":
                guard w.count == 3, let x = Double(w[1]), let y = Double(w[2]) else { throw Bad.usage("m <x> <y>") }
                click(x, y)
            case "v":
                guard w.count == 3, let x = Double(w[1]), let y = Double(w[2]) else { throw Bad.usage("v <x> <y>") }
                move(x, y)
            default: throw Bad.usage("unknown command \(line)")
            }
            print("ok")
        } catch Bad.usage(let why) {
            print("error \(why)")
        } catch {
            print("error \(error)")
        }
    }
}

let a = CommandLine.arguments
do {
    switch a.count > 1 ? a[1] : "" {
    case "type": for c in (a.count > 2 ? a[2] : "") { char(c) }
    case "key":
        guard a.count > 2 else { throw Bad.usage("key <name> [mods]") }
        try key(a[2], a.count > 3 ? a[3] : "")
    case "click":
        guard a.count > 3, let x = Double(a[2]), let y = Double(a[3]) else { throw Bad.usage("click <x> <y>") }
        click(x, y)
    case "move":
        guard a.count > 3, let x = Double(a[2]), let y = Double(a[3]) else { throw Bad.usage("move <x> <y>") }
        move(x, y)
    case "idle": print(CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: CGEventType(rawValue: ~0)!))
    case "serve": serve()
    default: throw Bad.usage("type <text> | key <name> [mods] | click <x> <y> | move <x> <y> | idle | serve")
    }
} catch Bad.usage(let why) {
    FileHandle.standardError.write(Data("h14-key: \(why)\n".utf8)); exit(2)
}
