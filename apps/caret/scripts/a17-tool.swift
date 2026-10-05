// A17's helper for the VM acceptance runs (clipboard_race.py, undo_textedit.py). The rig VM only:
// `type` and `cmdz` post HID events, and `seed`, `copy` and `copy-when` write the general
// pasteboard, which in the guest belongs to nobody. Never run these on Sam's desktop.
//
//   a17-tool dump                          the pasteboard: changeCount, and per item each type with a
//                                          SHA-256 of its bytes (contents are never printed whole)
//   a17-tool seed rich|text|empty          the prior contents a run starts from. rich: rich text, HTML,
//                                          plain text and a private type, plus a file URL item, which
//                                          Caret refuses to paste over (I3). text: rich text, HTML and
//                                          plain text, plus a PNG item, all restorable. empty: nothing
//   a17-tool copy <text>                   a plain-text copy, as the user's
//   a17-tool copy-when <pid> <text> <s>    waits until Caret's marked item is on the pasteboard and the
//                                          app's focused field holds its text, then copies <text>: the
//                                          user copying in the middle of a paste. Prints when.
//   a17-tool activate <pid>                brings the app forward and waits until it is frontmost
//   a17-tool value <pid>                   the focused element's value and selection
//   a17-tool undo-title <pid>              Edit > Undo's title and whether it is enabled
//   a17-tool type <pid> <text>             HID keystrokes, only while <pid> is frontmost
//   a17-tool cmdz <pid>                    HID ⌘Z, only while <pid> is frontmost
//   a17-tool newdoc <pid>                  HID ⌘N, only while <pid> is frontmost: a fresh undo history
//   a17-tool key <pid> <name>              one HID key, only while <pid> is frontmost: tab, down, up,
//                                          esc, cmd1, cmd2, cmd3 (T2's writing acceptance)
//   a17-tool windows <pid>                 the app's on-screen windows: number and frame (global,
//                                          top-left points), for `screencapture -l`
//   a17-tool screen-windows                every on-screen window, front to back: number, owner pid,
//                                          name and bundle, layer, alpha and frame; and the front app
//
// Each prints one JSON object.
import AppKit
import ApplicationServices
import CryptoKit

func emit(_ o: [String: Any]) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
    exit(o["error"] == nil ? 0 : 1)
}

// LaunchServices activation by bundle id (a background process's own activate() is ignored), then
// the app's own Window > Bring All to Front, as A12's harness does for TextEdit.
func bringForward(_ pid: pid_t) {
    guard let bundle = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier else { return }
    let open = Process()
    open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    open.arguments = ["-b", bundle]
    try? open.run()
    open.waitUntilExit()
    let app = AXUIElementCreateApplication(pid)
    var bar: AnyObject?
    guard AXUIElementCopyAttributeValue(app, kAXMenuBarAttribute as CFString, &bar) == .success else { return }
    func kids(_ e: AXUIElement) -> [AXUIElement] {
        var v: AnyObject?
        return AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &v) == .success ? (v as? [AXUIElement]) ?? [] : []
    }
    func title(_ e: AXUIElement) -> String? {
        var v: AnyObject?
        return AXUIElementCopyAttributeValue(e, kAXTitleAttribute as CFString, &v) == .success ? v as? String : nil
    }
    for item in kids(bar as! AXUIElement) where title(item) == "Window" {
        for menu in kids(item) {
            for entry in kids(menu) where title(entry) == "Bring All to Front" { AXUIElementPerformAction(entry, kAXPressAction as CFString) }
        }
    }
}

let args = Array(CommandLine.arguments.dropFirst())
guard let verb = args.first else { emit(["error": "usage: see the header"]) }
let pb = NSPasteboard.general
let marker = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")

func describe() -> [String: Any] {
    let items = (pb.pasteboardItems ?? []).map { item -> [[String: Any]] in
        item.types.map { type -> [String: Any] in
            let data = item.data(forType: type) ?? Data()
            let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined().prefix(16)
            return ["type": type.rawValue, "bytes": data.count, "sha": String(digest)]
        }
    }
    // The guest's pasteboard holds only this run's synthetic text, so its plain text is shown too.
    return ["changeCount": pb.changeCount, "items": items, "plain": pb.string(forType: .string) ?? NSNull()]
}

func attr(_ e: AXUIElement, _ a: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(e, a as CFString, &v) == .success ? v : nil
}
func focused(_ pid: pid_t) -> AXUIElement? { attr(AXUIElementCreateApplication(pid), kAXFocusedUIElementAttribute).map { $0 as! AXUIElement } }
func value(_ pid: pid_t) -> String? { focused(pid).flatMap { attr($0, kAXValueAttribute) as? String } }
func front(_ pid: pid_t) -> Bool { NSWorkspace.shared.frontmostApplication?.processIdentifier == pid }
let hid = CGEventSource(stateID: .hidSystemState)
func post(_ code: CGKeyCode, _ flags: CGEventFlags = [], unicode: UInt16? = nil) {
    for down in [true, false] {
        let e = CGEvent(keyboardEventSource: hid, virtualKey: code, keyDown: down)!
        e.flags = flags
        if var u = unicode { e.keyboardSetUnicodeString(stringLength: 1, unicodeString: &u) }
        e.post(tap: .cghidEventTap)
    }
}
func pid(_ i: Int) -> pid_t {
    guard args.count > i, let p = pid_t(args[i]) else { emit(["error": "a pid is needed"]) }
    return p
}

switch verb {
case "dump":
    emit(describe())
case "seed":
    pb.clearContents()
    if args.count > 1, args[1] == "rich" {
        let first = NSPasteboardItem()
        first.setData(Data("{\\rtf1\\ansi {\\b Prior} contents}".utf8), forType: .rtf)
        first.setString("<b>Prior</b> contents", forType: .html)
        first.setString("Prior contents", forType: .string)
        first.setData(Data((0..<64).map { UInt8($0) }), forType: NSPasteboard.PasteboardType("dev.caret.a17.private"))
        let second = NSPasteboardItem()
        second.setString("file:///private/tmp/a17-prior.txt", forType: .fileURL)
        pb.writeObjects([first, second])
    } else if args.count > 1, args[1] == "text" {
        let first = NSPasteboardItem()
        first.setData(Data("{\\rtf1\\ansi {\\b Prior} contents}".utf8), forType: .rtf)
        first.setString("<b>Prior</b> contents", forType: .html)
        first.setString("Prior contents", forType: .string)
        let second = NSPasteboardItem()
        second.setData(Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), forType: .png)
        pb.writeObjects([first, second])
    }
    emit(describe())
case "copy":
    guard args.count > 1 else { emit(["error": "copy <text>"]) }
    pb.clearContents()
    pb.setString(args[1], forType: .string)
    emit(describe())
case "copy-when":
    let p = pid(1)
    guard args.count > 3, let limit = Double(args[3]) else { emit(["error": "copy-when <pid> <text> <seconds>"]) }
    let started = Date()
    var sawMarker: Date?
    while Date().timeIntervalSince(started) < limit {
        if sawMarker == nil, pb.types?.contains(marker) == true { sawMarker = Date() }
        if let seen = sawMarker, let caret = pb.string(forType: .string), value(p)?.contains(caret) == true, pb.types?.contains(marker) == true {
            let before = pb.changeCount
            pb.clearContents()
            pb.setString(args[2], forType: .string)
            emit(["copied": true, "afterMarkerMs": Int(Date().timeIntervalSince(seen) * 1000), "changeCountBefore": before, "after": describe()])
        }
        usleep(1000)
    }
    emit(["copied": false, "sawMarker": sawMarker != nil, "after": describe()])
case "activate":
    let p = pid(1)
    bringForward(p)
    for _ in 0..<50 where !front(p) { usleep(100_000) }
    emit(["front": front(p)])
case "value":
    let p = pid(1)
    var r = CFRange()
    if let e = focused(p), let v = attr(e, kAXSelectedTextRangeAttribute) { AXValueGetValue(v as! AXValue, .cfRange, &r) }
    emit(["value": value(p) ?? NSNull(), "selection": [r.location, r.length]])
case "undo-title":
    let p = pid(1)
    if let bar = attr(AXUIElementCreateApplication(p), kAXMenuBarAttribute) {
        for item in (attr(bar as! AXUIElement, kAXChildrenAttribute) as? [AXUIElement]) ?? [] where (attr(item, kAXTitleAttribute) as? String) == "Edit" {
            for menu in (attr(item, kAXChildrenAttribute) as? [AXUIElement]) ?? [] {
                for entry in (attr(menu, kAXChildrenAttribute) as? [AXUIElement]) ?? [] {
                    if let t = attr(entry, kAXTitleAttribute) as? String, t.hasPrefix("Undo") {
                        emit(["title": t, "enabled": (attr(entry, kAXEnabledAttribute) as? Bool) ?? false])
                    }
                }
            }
        }
    }
    emit(["error": "no Edit > Undo item"])
case "type":
    let p = pid(1)
    guard args.count > 2 else { emit(["error": "type <pid> <text>"]) }
    for unit in args[2].utf16 {
        guard front(p) else { emit(["error": "not frontmost; stopped typing"]) }
        post(0, unicode: unit)
        usleep(40_000)
    }
    usleep(200_000)
    emit(["value": value(p) ?? NSNull()])
case "cmdz":
    let p = pid(1)
    guard front(p) else { emit(["error": "not frontmost; no key sent"]) }
    post(6, .maskCommand)
    usleep(400_000)
    emit(["value": value(p) ?? NSNull()])
case "newdoc":
    let p = pid(1)
    guard front(p) else { emit(["error": "not frontmost; no key sent"]) }
    post(45, .maskCommand)
    usleep(900_000)
    emit(["value": value(p) ?? NSNull()])
case "key":
    let p = pid(1)
    let keys: [String: (CGKeyCode, CGEventFlags)] = [
        "tab": (48, []), "down": (125, []), "up": (126, []), "esc": (53, []),
        "cmd1": (18, .maskCommand), "cmd2": (19, .maskCommand), "cmd3": (20, .maskCommand),
    ]
    guard args.count > 2, let (code, flags) = keys[args[2]] else { emit(["error": "key <pid> tab|down|up|esc|cmd1|cmd2|cmd3"]) }
    guard front(p) else { emit(["error": "not frontmost; no key sent"]) }
    post(code, flags)
    usleep(300_000)
    emit(["value": value(p) ?? NSNull()])
case "windows":
    let p = pid(1)
    let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
    let mine = list.filter { ($0[kCGWindowOwnerPID as String] as? Int).map(pid_t.init) == p }.compactMap { w -> [String: Any]? in
        guard let number = w[kCGWindowNumber as String] as? Int, let b = w[kCGWindowBounds as String] as? [String: Double] else { return nil }
        return ["number": number, "frame": [b["X"] ?? 0, b["Y"] ?? 0, b["Width"] ?? 0, b["Height"] ?? 0], "layer": w[kCGWindowLayer as String] as? Int ?? 0]
    }
    emit(["windows": mine])
case "screen-windows":
    // Every on-screen window, front to back, with its owner, so a held offer's cover can be named (H7b:
    // V1b's check 7 held five Tab offers as covered and nothing said by what).
    let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    let all = list.compactMap { w -> [String: Any]? in
        guard let number = w[kCGWindowNumber as String] as? Int, let owner = w[kCGWindowOwnerPID as String] as? Int,
              let b = w[kCGWindowBounds as String] as? [String: Double] else { return nil }
        let app = NSRunningApplication(processIdentifier: pid_t(owner))
        let name: Any = (w[kCGWindowOwnerName as String] as? String) ?? NSNull()
        let bundle: Any = app?.bundleIdentifier ?? NSNull()
        let agent: Any = app.map { $0.activationPolicy != .regular } ?? NSNull()
        return ["number": number, "pid": owner, "owner": name, "bundle": bundle, "agent": agent,
                "layer": w[kCGWindowLayer as String] as? Int ?? 0, "alpha": w[kCGWindowAlpha as String] as? Double ?? 1,
                "frame": [b["X"] ?? 0, b["Y"] ?? 0, b["Width"] ?? 0, b["Height"] ?? 0]]
    }
    let app = NSWorkspace.shared.frontmostApplication
    let frontBundle: Any = app?.bundleIdentifier ?? NSNull()
    emit(["front": ["pid": app?.processIdentifier ?? -1, "bundle": frontBundle], "windows": all])
default:
    emit(["error": "unknown verb \(verb)"])
}
