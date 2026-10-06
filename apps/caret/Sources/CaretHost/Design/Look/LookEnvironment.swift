import CaretHostCore
import SwiftUI

/// What the page panel's views read from their group: the motion this change calls for, the row the crop shows, and
/// whether the rows stagger in (a panel's first show only).
private struct LookMotionKey: EnvironmentKey {
    static let defaultValue = PageTaskLook.motion(.key, reduceMotion: false)
}

private struct LookFocusKey: EnvironmentKey {
    static let defaultValue: Int? = nil
}

private struct LookStaggerKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var lookMotion: PageTaskLook.Motion {
        get { self[LookMotionKey.self] }
        set { self[LookMotionKey.self] = newValue }
    }

    /// The goal step whose crop shows, which its row marks with the focus wash.
    var lookFocus: Int? {
        get { self[LookFocusKey.self] }
        set { self[LookFocusKey.self] = newValue }
    }

    var lookStagger: Bool {
        get { self[LookStaggerKey.self] }
        set { self[LookStaggerKey.self] = newValue }
    }
}

/// The named space the group lays the panel, the crop and the thread out in.
enum LookSpace {
    static let group = "pageTaskGroup"
}

/// Where things stand in the group, gathered from the views: each row's frame by goal step (the thread starts at its
/// trailing edge, and the coordinator finds the row under the pointer from them), the crop's frame, and the marked
/// span's line middle (the thread's end).
struct LookGeometry: Equatable {
    var rows: [Int: CGRect] = [:]
    var crop: CGRect?
    var spanY: CGFloat?
}

struct LookGeometryKey: PreferenceKey {
    static let defaultValue = LookGeometry()
    static func reduce(value: inout LookGeometry, nextValue: () -> LookGeometry) {
        let next = nextValue()
        value.rows.merge(next.rows) { $1 }
        value.crop = next.crop ?? value.crop
        value.spanY = next.spanY ?? value.spanY
    }
}

/// VoiceOver moved onto a row (step, true) or off it (false): the crop follows VoiceOver as it follows the pointer.
private struct LookTracksVoiceOverKey: EnvironmentKey { static let defaultValue = false }

private struct LookVoiceFocusKey: EnvironmentKey {
    static let defaultValue: @MainActor (Int, Bool) -> Void = { _, _ in }
}

extension EnvironmentValues {
    /// The live panel follows VoiceOver's row; renders do not.
    var lookTracksVoiceOver: Bool {
        get { self[LookTracksVoiceOverKey.self] }
        set { self[LookTracksVoiceOverKey.self] = newValue }
    }

    var lookVoiceFocus: @MainActor (Int, Bool) -> Void {
        get { self[LookVoiceFocusKey.self] }
        set { self[LookVoiceFocusKey.self] = newValue }
    }
}
