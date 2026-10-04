// The elements the reader wrote, by the helper's mark (B23, S1 audit #6). Before B23 undo walked the window again
// and wrote to whatever element then had the field's key, so an app that replaced the field with an identical
// sibling (same key, role and value) had the old value written into the sibling. Now each forward write names a
// mark, the reader keeps the native element it wrote under it, and a restore names the mark back: the element at
// the key must be that same element. Generic over the element so the rule is tested without Accessibility.
//
// One table per app worker, so a mark resolves only in the process incarnation that recorded it: a process that
// quits takes its worker and marks with it, and a restarted reader starts with none. Either way the restore is
// refused, never redirected.

public struct ElementMarks<Element: Equatable> {
    /// Marks kept per worker; the oldest goes first past this. A run writes a few fields and undo can come any time,
    /// so this is room for a few hundred runs in one app. Assumed, not measured. A mark that went is refused.
    public static var limit: Int { 512 }

    private var byMark: [String: Element] = [:]
    private var order: [String] = []

    public init() {}

    public var count: Int { byMark.count }

    /// Records `element` as the one written under `mark`, replacing what the mark named before.
    public mutating func record(_ mark: String, _ element: Element) {
        if byMark.updateValue(element, forKey: mark) == nil { order.append(mark) }
        while order.count > Self.limit {
            byMark.removeValue(forKey: order.removeFirst())
        }
    }

    /// Nil when `current`, the element at the key now, is the one recorded under `mark`; otherwise the detail of the
    /// notSameElement answer.
    public func refusal(sameAs mark: String, current: Element) -> String? {
        guard let kept = byMark[mark] else {
            return "the reader holds no element under this mark: it restarted, or the field's process went, since Caret wrote it"
        }
        return kept == current ? nil : "another element now has this key"
    }
}
