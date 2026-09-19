import ApplicationServices
import Foundation

/// Assigns a stable token to each distinct accessibility element seen in this
/// session.
///
/// `AXUIElement` has no public identifier, and the readable attributes are not
/// unique: two fields can share a position, and two windows can share a title,
/// so a token derived from those would let a stale offer apply to a different
/// field that happens to look the same. `CFEqual` does compare the underlying
/// element, so elements are retained and matched with it, and each new one is
/// handed a counter value that cannot collide.
final class AXIdentityRegistry {
    private struct Entry {
        let element: AXUIElement
        let token: String
    }

    private let prefix: String
    private let capacity: Int
    private var entries: [Entry] = []
    private var counter = 0

    init(prefix: String, capacity: Int = 64) {
        self.prefix = prefix
        self.capacity = capacity
    }

    /// The token for this element, minting one the first time it is seen.
    func token(for element: AXUIElement) -> String {
        if let index = entries.firstIndex(where: { CFEqual($0.element, element) }) {
            let entry = entries.remove(at: index)
            entries.append(entry)
            return entry.token
        }
        counter += 1
        let token = "\(prefix)-\(counter)"
        entries.append(Entry(element: element, token: token))
        if entries.count > capacity { entries.removeFirst(entries.count - capacity) }
        return token
    }

    func reset() {
        entries.removeAll()
    }
}
