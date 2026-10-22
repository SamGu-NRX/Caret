import CaretHostCore
import SwiftUI

// H12: the key field on onboarding's `on` step in each state its check can leave it, and the step alone as the menu's
// "Jev is off" opens it. The pasted key is a synthetic string of the length a TypeSafe key has.
extension Gallery {
    static let sampleJevKey = "ts-live-" + String(repeating: "x", count: 40)

    static func onboardingJevKey(_ character: FigureCharacter = .pebble) -> [Item] {
        func flow(alone: Bool = false, stored: Bool = false, _ events: [OnboardingFlow.Event]) -> OnboardingFlow.State {
            let flow = OnboardingFlow(settings: CaretSettings(), permissions: OnboardingPermissions(accessibility: true, inputMonitoring: true),
                                      clock: StillClock(), opening: .init(step: .on, alone: alone), jevKeyAvailable: false, jevKeyStored: stored)
            flow.start()
            for event in events { flow.send(event) }
            return flow.state
        }
        let preview = OnboardingPreview(previewId: "pv", windows: [.init(bundleId: "com.apple.mail", appName: "Mail", title: "Thursday?",
                                                                         lines: [.init(text: "Thursday at 3 for coffee?"), .init(text: nil)], chars: 25)], chars: 25)
        let ready: [OnboardingFlow.Event] = [.previewReady(requestId: "preview-1-1", preview)]
        let typed = ready + [.setJevKey(sampleJevKey)]
        let checking = typed + [.next]
        let screens: [(String, OnboardingFlow.State)] = [
            ("key", flow(ready)),
            ("key-typed", flow(typed)),
            ("key-checking", flow(checking)),
            // The saved key restarts the helper, so the preview is built again; drawn once it is back.
            ("key-no-credits", flow(checking + [.jevKeyChecked(.noCredits, saved: true), .previewReady(requestId: "preview-1-2", preview)])),
            ("key-rejected", flow(checking + [.jevKeyChecked(.rejected, saved: false)])),
            ("key-unreachable", flow(checking + [.jevKeyChecked(.unreachable, saved: false)])),
            ("key-alone-stored", flow(alone: true, stored: true, ready)),
        ]
        return screens.map { name, state in
            Item(name: "onboarding-\(name)", view: AnyView(OnboardingView(state: state, character: character, animated: false, promise: samplePrivacyPromise)))
        }
    }
}
