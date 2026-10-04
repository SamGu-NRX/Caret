// B21 part 3: posts one key, down then up, to a process the evaluation started, so the reader's press watch can
// be tested on Return, keypad Enter and Space. The key goes to that pid alone (CGEventPostToPid), never through
// the HID or session tap, so it cannot land in a window someone else is using. The process is checked to be
// running immediately before each event.
//
//   key-post PID KEYCODE    -> one JSON line
import AppKit
import Foundation

func out(_ o: [String: Any]) -> Never {
    let d = (try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])) ?? Data("{\"ok\":false}".utf8)
    print(String(decoding: d, as: UTF8.self))
    exit(0)
}

let a = Array(CommandLine.arguments.dropFirst())
guard a.count == 2, let pid = pid_t(a[0]), let code = CGKeyCode(a[1]) else { out(["ok": false, "error": "usage: key-post PID KEYCODE"]) }
// Only the three keys the press watch reads: anything else is not this probe's business.
guard [36, 49, 76].contains(Int(code)) else { out(["ok": false, "error": "key-post posts only Return (36), Space (49) and keypad Enter (76)"]) }

/// Posted input resets HIDIdleTime as a person's does, so the GUI gate is told when this program posts: "busy
/// DEADLINE" in CARET_SYNTHETIC_FILE while posting, then the end time (helper/scripts/synthetic-input.ts).
func markPosting(_ busy: Bool) {
    guard let f = ProcessInfo.processInfo.environment["CARET_SYNTHETIC_FILE"], !f.isEmpty else { return }
    let ms = Int64(Date().timeIntervalSince1970 * 1000)
    try? (busy ? "busy \(ms + 5000)" : "\(ms)").write(toFile: f, atomically: true, encoding: .utf8)
}

func post(_ down: Bool) -> Bool {
    guard NSRunningApplication(processIdentifier: pid) != nil,
          let e = CGEvent(keyboardEventSource: CGEventSource(stateID: .privateState), virtualKey: code, keyDown: down) else { return false }
    e.flags = code == 76 ? .maskNumericPad : []
    e.postToPid(pid)
    return true
}
markPosting(true)
let downPosted = post(true)
Thread.sleep(forTimeInterval: 0.05)
let upPosted = post(false)
markPosting(false)
out(["ok": downPosted && upPosted, "code": Int(code), "at": Int64(Date().timeIntervalSince1970 * 1000)])
