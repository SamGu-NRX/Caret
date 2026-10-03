// The evaluation's own eyes and hands in an app with no test hooks (TextEdit): reads and sets the text of
// a window's first text area, lists windows, presses a menu item, and prints a window's tree. It acts
// only on the process named on the command line, which the evaluation started itself, and shares no
// code with caret-screen, so its reads check the executor without trusting the reader.
// A window is named by a title prefix, or by "#N", its window server number (CGWindowID), which stays
// right when a second window's title shares the prefix.
//   ax-probe windows PID
//   ax-probe text PID TITLE_PREFIX            -> {"ok":true,"value":"..."}
//   ax-probe focused PID TITLE_PREFIX         -> {"ok":true,"focused":true|false} for the first text area
//   ax-probe set-text PID TITLE_PREFIX VALUE  (plays the user typing; never used to check a result)
//   ax-probe menu PID MENU ITEM               (AXPress on a menu bar item, not a click)
//   ax-probe tree PID TITLE_PREFIX
import ApplicationServices
import Foundation

@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError
func number(_ w: AXUIElement) -> Int? {
    var id: CGWindowID = 0
    return _AXUIElementGetWindow(w, &id) == .success && id != 0 ? Int(id) : nil
}

func out(_ o: [String: Any]) -> Never {
    let d = (try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])) ?? Data("{\"ok\":false}".utf8)
    print(String(decoding: d, as: UTF8.self))
    exit((o["ok"] as? Bool) == true ? 0 : 1)
}
func attr(_ e: AXUIElement, _ n: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(e, n as CFString, &v) == .success ? v : nil
}
func str(_ e: AXUIElement, _ n: String) -> String? { attr(e, n) as? String }
func kids(_ e: AXUIElement) -> [AXUIElement] { (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func find(_ e: AXUIElement, role: String, depth: Int = 0) -> AXUIElement? {
    if str(e, kAXRoleAttribute) == role { return e }
    if depth > 14 { return nil }
    for k in kids(e) { if let f = find(k, role: role, depth: depth + 1) { return f } }
    return nil
}

let a = Array(CommandLine.arguments.dropFirst())
guard a.count >= 2, let pid = pid_t(a[1]) else { out(["ok": false, "error": "usage: ax-probe CMD PID ..."]) }
let app = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(app, 1)
let windows = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
func window(_ sel: String) -> AXUIElement {
    let match: (AXUIElement) -> Bool = sel.hasPrefix("#") ? { number($0) == Int(sel.dropFirst()) } : { (str($0, kAXTitleAttribute) ?? "").hasPrefix(sel) }
    guard let w = windows.first(where: match) else {
        let prefix = sel
        out(["ok": false, "error": "no window of \(pid) starts with '\(prefix)'", "titles": windows.map { str($0, kAXTitleAttribute) ?? "" }])
    }
    return w
}

switch a[0] {
case "windows":
    out(["ok": true, "titles": windows.map { str($0, kAXTitleAttribute) ?? "" }, "numbers": windows.map { number($0) ?? 0 }])
case "text" where a.count == 3:
    guard let area = find(window(a[2]), role: kAXTextAreaRole) else { out(["ok": false, "error": "no text area"]) }
    out(["ok": true, "value": str(area, kAXValueAttribute) ?? NSNull()])
case "focused" where a.count == 3:
    guard let area = find(window(a[2]), role: kAXTextAreaRole) else { out(["ok": false, "error": "no text area"]) }
    out(["ok": true, "focused": (attr(area, kAXFocusedAttribute) as? Bool) ?? false])
case "set-text" where a.count == 4:
    guard let area = find(window(a[2]), role: kAXTextAreaRole) else { out(["ok": false, "error": "no text area"]) }
    let r = AXUIElementSetAttributeValue(area, kAXValueAttribute as CFString, a[3] as CFString)
    out(["ok": r == .success, "error": r.rawValue])
case "menu" where a.count == 4:
    guard let bar = attr(app, kAXMenuBarAttribute) else { out(["ok": false, "error": "no menu bar"]) }
    let barEl = bar as! AXUIElement
    guard let top = kids(barEl).first(where: { str($0, kAXTitleAttribute) == a[2] }),
          let menu = kids(top).first,
          let item = kids(menu).first(where: { str($0, kAXTitleAttribute) == a[3] }) else { out(["ok": false, "error": "no menu item \(a[2]) > \(a[3])"]) }
    let r = AXUIElementPerformAction(item, kAXPressAction as CFString)
    out(["ok": r == .success, "error": r.rawValue])
case "tree" where a.count == 3:
    var lines: [String] = []
    func walk(_ e: AXUIElement, _ d: Int) {
        guard d < 14, lines.count < 400 else { return }
        let role = str(e, kAXRoleAttribute) ?? "?"
        let label = str(e, kAXTitleAttribute) ?? str(e, kAXDescriptionAttribute) ?? ""
        let value = (attr(e, kAXValueAttribute)).map { "\($0)" } ?? ""
        let settable: Bool = { var s: DarwinBoolean = false; return AXUIElementIsAttributeSettable(e, kAXValueAttribute as CFString, &s) == .success && s.boolValue }()
        lines.append(String(repeating: "  ", count: d) + "\(role) '\(label.prefix(40))' v='\(value.prefix(40))'\(settable ? " settable" : "")")
        for k in kids(e) { walk(k, d + 1) }
    }
    walk(window(a[2]), 0)
    out(["ok": true, "tree": lines])
default:
    out(["ok": false, "error": "unknown command \(a.joined(separator: " "))"])
}
