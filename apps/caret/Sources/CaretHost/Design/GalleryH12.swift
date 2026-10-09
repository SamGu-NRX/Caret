import CaretHostCore
import SwiftUI

// H12: onboarding's Jev key step in each state its check can leave it, the step alone as the menu's "Jev is off" opens
// it, and the permissions step alone as a returning user missing Accessibility sees it. The pasted key is a synthetic
// string of the length a TypeSafe key has.
extension Gallery {
    static let sampleJevKey = "ts-live-" + String(repeating: "x", count: 40)

    static func onboardingJevKey(_ character: FigureCharacter = .pebble) -> [Item] {
        func flow(only: OnboardingStep? = nil, stored: Bool = false, ax: Bool = true, _ events: [OnboardingFlow.Event]) -> OnboardingFlow.State {
            let flow = OnboardingFlow(settings: CaretSettings(), permissions: OnboardingPermissions(accessibility: ax, inputMonitoring: true),
                                      clock: StillClock(), jevKeyAvailable: false, jevKeyStored: stored, only: only)
            for event in events { flow.send(event) }
            return flow.state
        }
        // Welcome, work, permissions: the key step is the fourth in a flow without the know step.
        let toKey: [OnboardingFlow.Event] = [.next, .next, .next]
        let typed = toKey + [.setJevKey(sampleJevKey)]
        let checking = typed + [.next]
        let screens: [(String, OnboardingFlow.State)] = [
            ("key", flow(toKey)),
            ("key-typed", flow(typed)),
            ("key-checking", flow(checking)),
            ("key-works", flow(checking + [.jevKeyChecked(.works, saved: true)])),
            ("key-no-credits", flow(checking + [.jevKeyChecked(.noCredits, saved: true)])),
            ("key-rejected", flow(checking + [.jevKeyChecked(.rejected, saved: false)])),
            ("key-unreachable", flow(checking + [.jevKeyChecked(.unreachable, saved: false)])),
            ("key-alone-stored", flow(only: .jevKey, stored: true, [])),
            ("permissions-alone", flow(only: .permissions, ax: false, [])),
        ]
        return screens.map { name, state in
            Item(name: "onboarding-\(name)", view: AnyView(OnboardingView(state: state, character: character, animated: false, promise: samplePrivacyPromise)))
        }
    }
}
