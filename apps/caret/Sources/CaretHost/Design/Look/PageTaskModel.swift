import AppKit
import CaretHostCore
import SwiftUI

/// The panel's live model: the coordinator sets it inside the motion the change calls for.
@MainActor
final class PageTaskModel: ObservableObject {
    @Published var panel: PageTaskPanel?
    /// Off for a change a key made: nothing in the panel moves for Tab, Esc or ⌘Z, the figure included.
    @Published var animated = true
    /// What made the last change, which picks its motion (`PageTaskLook.motion`).
    @Published var cause: PageTaskLook.Cause = .helper
    /// The goal step whose crop shows, and where the crop stands.
    @Published var crop: Int?
    @Published var side: PageTaskLook.CropSide = .trailing
    /// The panel's first show: its rows stagger in.
    @Published var stagger = false
    /// Where the rows are in the panel's content, for the pointer (not published: nothing redraws for it).
    var geometry = LookGeometry()
    /// H14: a click on an attach row.
    var onAttach: (Int) -> Void = { _ in }
    /// VoiceOver moved onto or off a row.
    var onVoiceFocus: (Int, Bool) -> Void = { _, _ in }
}

/// The panel as the hosted panel shows it, over the observed model.
struct PageTaskLiveView: View {
    @ObservedObject var model: PageTaskModel
    var character: FigureCharacter
    var animated: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.reducesMotion) private var reducesMotion

    var body: some View {
        if let panel = model.panel {
            PageTaskGroupView(panel: panel, crop: model.crop, side: model.side, character: character, animated: animated && model.animated, onAttach: model.onAttach)
                .environment(\.lookMotion, PageTaskLook.motion(model.cause, reduceMotion: reduceMotion || reducesMotion))
                .environment(\.lookStagger, model.stagger)
                .environment(\.lookTracksVoiceOver, true)
                .environment(\.lookVoiceFocus) { [weak model] step, on in model?.onVoiceFocus(step, on) }
                .onPreferenceChange(LookGeometryKey.self) { [weak model] g in
                    MainActor.assumeIsolated { model?.geometry = g }
                }
        }
    }
}
