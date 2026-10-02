import ApplicationServices
import CaretHostCore
import Foundation

/// Rechecks, just before a fill is written, that the value is still on screen where the helper
/// found it.
///
/// The proposal names the source by the reader's window id (`<pid>-<n>`), window title and element
/// key. The host cannot resolve reader keys, so it looks in that pid's windows with that title for
/// any element whose text contains the value verbatim. A source that was edited, or whose window
/// closed or was renamed, fails the check, and the fill is refused rather than writing a value the
/// user can no longer see. The check is bounded so a huge window cannot stall the insertion queue.
enum SourceCheck {
    enum Outcome: Equatable {
        case present
        /// No window of the source app has the source's title.
        case windowGone
        /// The window is there and the value is not in it.
        case valueGone
        /// The walk hit its node or time budget before finding the value.
        case inconclusive
        case sourceUnknown
    }

    static let maxNodes = 4_000
    static let deadline: TimeInterval = 0.25

    static func check(value: String, origin: FillOrigin) -> Outcome {
        guard let pid = origin.sourcePID else { return .sourceUnknown }
        let app = AXUIElementCreateApplication(pid)
        let windows = AXRead.elements(kAXWindowsAttribute, on: app)
            .filter { AXRead.string(kAXTitleAttribute, on: $0) == origin.sourceWindowTitle }
        guard !windows.isEmpty else { return .windowGone }
        let started = Date()
        var queue = windows
        var visited = 0
        while !queue.isEmpty {
            let element = queue.removeFirst()
            visited += 1
            for attribute in [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute] {
                if let text = AXRead.string(attribute, on: element), text.contains(value) { return .present }
            }
            if visited >= maxNodes || Date().timeIntervalSince(started) > deadline { return .inconclusive }
            queue.append(contentsOf: AXRead.elements(kAXChildrenAttribute, on: element))
        }
        return .valueGone
    }
}
