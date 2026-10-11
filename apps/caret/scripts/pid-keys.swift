// Posts keys to one process with CGEventPostToPid, for the A13 on-screen run's ask field: the
// host's own list panel, which cua-driver's background route refuses because Caret's panels are not
// among the process's AXWindows. Nothing goes to the HID stream or the session event tap.
//
//   pid-keys <pid> <expected executable name> <key>...    key: return | tab | escape | text:<string>
//
// Refuses unless the pid is alive and its executable is the expected one, rechecked right before
// every event, so a reused pid never receives a key. Prints one JSON line.
import CoreGraphics
import Darwin
import Foundation

let args = CommandLine.arguments
guard args.count >= 4, let pid = pid_t(args[1]) else {
    FileHandle.standardError.write(Data("usage: pid-keys <pid> <name> return|tab|escape|text:<s>...\n".utf8))
    exit(2)
}
let expected = args[2]

// The kernel's path for the pid, not NSRunningApplication, which a command-line tool without a run
// loop saw return nothing for a live host mid-run (A13 ask-light, typing refused after 24 keys).
func isExpected() -> Bool {
    guard kill(pid, 0) == 0 else { return false }
    var buffer = [CChar](repeating: 0, count: 4096)
    guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return false }
    return URL(fileURLWithPath: String(cString: buffer)).lastPathComponent == expected
}

func post(_ code: CGKeyCode, text: String? = nil) -> Bool {
    guard isExpected(), let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { return false }
    if let text {
        let units = Array(text.utf16)
        down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
    }
    down.postToPid(pid)
    usleep(8_000)
    guard isExpected() else { return false }
    up.postToPid(pid)
    usleep(12_000)
    return true
}

var sent: [String] = []
for key in args.dropFirst(3) {
    var ok = false
    switch key {
    case "return": ok = post(36)
    case "tab": ok = post(48)
    case "escape": ok = post(53)
    default:
        guard key.hasPrefix("text:") else { break }
        ok = true
        // One key event per character, carrying the character itself.
        for ch in key.dropFirst(5) where ok { ok = post(0, text: String(ch)) }
    }
    guard ok else {
        print(#"{"ok":false,"failedAt":"\#(key.prefix(20))","sent":\#(sent.count)}"#)
        exit(1)
    }
    sent.append(key.hasPrefix("text:") ? "text" : key)
}
print(#"{"ok":true,"sent":\#(sent.count)}"#)
