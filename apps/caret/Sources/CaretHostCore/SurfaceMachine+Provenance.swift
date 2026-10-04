import Foundation

// M1's provenance on an offer: the helper names the noticed facts an offer was built from right after
// the offer, by its key. The machine keeps the last few and says which belongs to the offer on
// screen; the host draws it as a tab under the slip with "Not right" (SurfaceCoordinator), and sends
// what the user says through `MemoryBook.notRight`. Nothing here changes what Tab or typing do.
extension SurfaceMachine {
    /// Offers whose provenance is kept. The helper sends it right after the offer, so only an offer
    /// still being drawn or held needs it; a few cover an offer re-sent under the same key.
    static let provenanceKept = 8

    public func provenance(_ p: MemoryProvenance) {
        count("surface.provenance")
        provenances.removeAll { $0.key == p.offerKey }
        provenances.append((p.offerKey, p))
        if provenances.count > Self.provenanceKept { provenances.removeFirst(provenances.count - Self.provenanceKept) }
        // On screen already: draw it again, now with where its facts came from.
        if let shown, shown.offerKey == p.offerKey, work == nil, resultTimer == nil {
            draw(ui: arbiter.snapshot().ui, entering: false)
        }
    }

    /// The provenance of the offer on screen, while the panel shows that offer (not work or a result
    /// after it): what the tab under the slip names. Nil for a ghost offer, which has no slip.
    public var shownProvenance: MemoryProvenance? {
        guard let shown, let key = shown.offerKey, work == nil, resultTimer == nil, panelUp else { return nil }
        switch shown.offer.kind {
        case .action, .popup: return provenances.last { $0.key == key }?.value
        case .ghost, .fill: return nil
        }
    }
}
