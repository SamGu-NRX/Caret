// E1 driver for an app with no scripting of its own (TextEdit): every period, writes a marker into
// the first text area of the window whose title contains --title, through Accessibility, and logs
// the write. Acts only on that one window, which the experiment opened itself.
//   drive-ax-value --pid P --title T --count N --period S --log FILE
import ApplicationServices
import Foundation

var a = Array(CommandLine.arguments.dropFirst())
func opt(_ n: String) -> String { guard let i = a.firstIndex(of: n), i + 1 < a.count else { fatalError("missing \(n)") }; return a[i + 1] }
let pid = pid_t(opt("--pid"))!, title = opt("--title"), count = Int(opt("--count"))!, period = Double(opt("--period"))!
FileManager.default.createFile(atPath: opt("--log"), contents: nil)
let log = FileHandle(forWritingAtPath: opt("--log"))!
func attr(_ e: AXUIElement, _ n: String) -> CFTypeRef? { var v: CFTypeRef?; return AXUIElementCopyAttributeValue(e, n as CFString, &v) == .success ? v : nil }
func find(_ e: AXUIElement, _ role: String, _ depth: Int = 0) -> AXUIElement? {
    if (attr(e, kAXRoleAttribute) as? String) == role { return e }
    if depth > 12 { return nil }
    for k in (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] { if let f = find(k, role, depth + 1) { return f } }
    return nil
}
let app = AXUIElementCreateApplication(pid)
guard let wins = attr(app, kAXWindowsAttribute) as? [AXUIElement],
      let w = wins.first(where: { ((attr($0, kAXTitleAttribute) as? String) ?? "").contains(title) }),
      let area = find(w, "AXTextArea") else { fatalError("no window titled \(title) with a text area in \(pid)") }
for n in 0..<count {
    let t = Int64(Date().timeIntervalSince1970 * 1000)
    let m = "T\(t)v\(n)"
    let r = AXUIElementSetAttributeValue(area, kAXValueAttribute as CFString, m as CFTypeRef)
    log.write(Data("{\"t\":\(t),\"action\":\"v\",\"marker\":\"\(m)\",\"ok\":\(r == .success)}\n".utf8))
    Thread.sleep(forTimeInterval: period)
}
