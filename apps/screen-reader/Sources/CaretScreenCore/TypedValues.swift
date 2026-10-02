// Typed values: dates, times, emails, phones, URLs, addresses, amounts and IDs found in node
// text. NSDataDetector finds dates, links, phones and addresses; regexes add what it misses or
// does not classify (emails without mailto, amounts, times, order and invoice numbers).
import Foundation

public struct DetectedValue: Equatable, Hashable, Sendable {
    public var kind: ValueKind
    public var text: String
    public init(kind: ValueKind, text: String) { self.kind = kind; self.text = text }
}

private extension NSRegularExpression {
    static func caseInsensitive(_ p: String) -> NSRegularExpression {
        try! NSRegularExpression(pattern: p, options: [.caseInsensitive])
    }
}

public final class TypedValueDetector: @unchecked Sendable {
    // NSRegularExpression and NSDataDetector are immutable and documented as thread safe.
    private let detector: NSDataDetector
    private let patterns: [(ValueKind, NSRegularExpression)]
    private let timeIn: NSRegularExpression
    private let dateWords: NSRegularExpression
    private let lock = NSLock()
    private var cache: [String: [DetectedValue]] = [:]
    /// Texts longer than this are scanned only up to it. Long texts are documents, scanned on their first screenful.
    public static let maxScan = 4000
    private static let cacheLimit = 20_000

    public init() {
        let types: NSTextCheckingResult.CheckingType = [.date, .link, .phoneNumber, .address]
        detector = try! NSDataDetector(types: types.rawValue)
        let re = { (p: String) in try! NSRegularExpression(pattern: p, options: []) }
        patterns = [
            (.email, re("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}")),
            (.amount, re("[$€£¥]\\s?\\d[\\d,]*(?:\\.\\d{1,2})?|\\b(?:USD|EUR|GBP|CAD|AUD)\\s?\\d[\\d,]*(?:\\.\\d{2})?\\b|\\b\\d[\\d,]*(?:\\.\\d{2})?\\s?(?:USD|EUR|GBP|CAD|AUD)\\b")),
            (.time, re("\\b(?:[01]?\\d|2[0-3]):[0-5]\\d(?:\\s?[AaPp]\\.?[Mm]\\.?)?(?![\\w:])|\\b(?:1[0-2]|0?[1-9])\\s?[AaPp]\\.?[Mm]\\.?(?![A-Za-z])")),
            // Uppercase letters and digits joined by hyphens (ORD-2026-48213, INV-2087), "#" plus digits,
            // or a short letter prefix on a long digit run (W1234567).
            (.id, re("\\b(?=[A-Z0-9-]*\\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9]+(?:-[A-Z0-9]+)+\\b|#\\d{4,}\\b|\\b[A-Z]{1,4}\\d{5,}\\b")),
        ]
        timeIn = re("(?:[01]?\\d|2[0-3]):[0-5]\\d(?:\\s?[AaPp]\\.?[Mm]\\.?)?|(?:1[0-2]|0?[1-9])\\s?[AaPp]\\.?[Mm]\\.?")
        dateWords = NSRegularExpression.caseInsensitive(
            "\\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|mon|tue|wed|thu|fri|sat|sun|today|tomorrow|yesterday|tonight|next|last)[a-z]*\\b|\\d{1,4}[/.-]\\d{1,2}")
    }

    /// Values in `text`, in order of appearance, with overlaps resolved by kind priority, then length.
    public func detect(_ text: String) -> [DetectedValue] {
        if text.count < 3 { return [] }
        lock.lock()
        if let hit = cache[text] { lock.unlock(); return hit }
        lock.unlock()
        let found = scan(text)
        lock.lock()
        if cache.count >= Self.cacheLimit { cache.removeAll(keepingCapacity: true) }
        cache[text] = found
        lock.unlock()
        return found
    }

    /// Lower wins: a phone number is never also reported as an ID, an email never as a URL.
    private static func priority(_ k: ValueKind) -> Int {
        switch k {
        case .email: 0
        case .url: 1
        case .phone: 2
        case .address: 3
        case .date: 4
        case .time: 4
        case .amount: 5
        case .id: 6
        }
    }

    private func scan(_ full: String) -> [DetectedValue] {
        let ns = full as NSString
        let range = NSRange(location: 0, length: min(ns.length, Self.maxScan))
        var hits: [(NSRange, ValueKind)] = []
        detector.enumerateMatches(in: full, options: [], range: range) { m, _, _ in
            guard let m else { return }
            switch m.resultType {
            case .link:
                hits.append((m.range, m.url?.scheme?.lowercased() == "mailto" ? .email : .url))
            case .phoneNumber:
                hits.append((m.range, .phone))
            case .address:
                hits.append((m.range, .address))
            case .date:
                // The detector's span can carry neighbouring words ("Starts at 3:30 PM"). A span with
                // no day, month or numeric date in it is a time, reported as just the time.
                let s = ns.substring(with: m.range)
                let sr = NSRange(location: 0, length: (s as NSString).length)
                if dateWords.firstMatch(in: s, range: sr) == nil, let t = timeIn.firstMatch(in: s, range: sr) {
                    hits.append((NSRange(location: m.range.location + t.range.location, length: t.range.length), .time))
                } else {
                    hits.append((m.range, .date))
                }
            default:
                break
            }
        }
        for (kind, re) in patterns {
            for m in re.matches(in: full, options: [], range: range) { hits.append((m.range, kind)) }
        }
        hits.sort { a, b in
            let pa = Self.priority(a.1), pb = Self.priority(b.1)
            return pa != pb ? pa < pb : a.0.length > b.0.length
        }
        var taken: [(NSRange, ValueKind)] = []
        for h in hits where !taken.contains(where: { NSIntersectionRange($0.0, h.0).length > 0 }) {
            taken.append(h)
        }
        taken.sort { $0.0.location < $1.0.location }
        var seen = Set<DetectedValue>()
        var out: [DetectedValue] = []
        for (r, kind) in taken {
            let t = ns.substring(with: r).trimmingCharacters(in: .whitespacesAndNewlines)
            if t.count < 3 { continue }
            let v = DetectedValue(kind: kind, text: t)
            if seen.insert(v).inserted { out.append(v) }
        }
        return out
    }

    /// Typed values for compacted nodes: an editable node's value, or another node's label and value.
    public func values(for nodes: [Node]) -> [TypedValue] {
        var out: [TypedValue] = []
        for n in nodes {
            if n.states.contains(.secure) { continue }
            let texts = n.editable ? [n.value] : [n.label, n.value]
            var seen = Set<DetectedValue>()
            for case let t? in texts {
                for v in detect(t) where seen.insert(v).inserted {
                    out.append(TypedValue(kind: v.kind, text: v.text, nodeKey: n.key))
                }
            }
        }
        return out
    }
}
