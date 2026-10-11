// Logs the Accessibility announcements one process posts, as VoiceOver would hear them, without
// turning VoiceOver on: an AXObserver on the process's application element for
// kAXAnnouncementRequestedNotification, the notification VoiceOver speaks. One JSON line per
// announcement on stdout ({"atMs", "text"}), until the process exits or this one is signalled.
// Nothing is posted and no setting changes. The pid must be listed in CARET_TEST_PIDS, so only a
// process the test started can be watched.
//
// Build: swiftc -O ax-announcements.swift -o ../.build/ax-announcements
// Usage: ax-announcements <pid>

import AppKit
import ApplicationServices

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("ax-announcements: \(message)\n".utf8))
    exit(2)
}

setvbuf(stdout, nil, _IOLBF, 0)
let args = Array(CommandLine.arguments.dropFirst())
guard args.count == 1, let pid = Int32(args[0]) else { fail("usage: ax-announcements <pid>") }
let allowed = Set((ProcessInfo.processInfo.environment["CARET_TEST_PIDS"] ?? "").split(separator: ",").compactMap { Int32($0) })
guard allowed.contains(pid) else { fail("refused: pid \(pid) is not in CARET_TEST_PIDS") }
guard AXIsProcessTrusted() else { fail("not trusted for Accessibility") }

let callback: AXObserverCallbackWithInfo = { _, _, notification, info, _ in
    let dict = info as NSDictionary? ?? [:]
    // AppKit may carry the words as an attributed string.
    let raw = dict[kAXAnnouncementKey as String]
    let text = (raw as? String) ?? (raw as? NSAttributedString)?.string
    // Every key the notification carried, for a post whose words arrive under another key.
    let keys = dict.allKeys.map { "\($0)" }.sorted()
    let line: [String: Any] = ["atMs": Date().timeIntervalSince1970 * 1000, "notification": notification as String, "text": text ?? NSNull(), "keys": keys]
    let data = try! JSONSerialization.data(withJSONObject: line, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
}

var observer: AXObserver?
guard AXObserverCreateWithInfoCallback(pid, callback, &observer) == .success, let observer else { fail("cannot observe pid \(pid)") }
let app = AXUIElementCreateApplication(pid)
let added = AXObserverAddNotification(observer, app, kAXAnnouncementRequestedNotification as CFString, nil)
guard added == .success else { fail("cannot watch announcements of pid \(pid): AXError \(added.rawValue)") }
CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(observer), .defaultMode)
print(#"{"ready":true}"#)

// Exit when the watched process does.
Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in
    if NSRunningApplication(processIdentifier: pid)?.isTerminated ?? true { exit(0) }
}
CFRunLoopRun()
