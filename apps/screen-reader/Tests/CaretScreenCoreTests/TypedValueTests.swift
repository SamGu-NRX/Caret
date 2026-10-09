import Testing
@testable import CaretScreenCore

@Suite struct TypedValues {
    private let d = TypedValueDetector()
    private func kinds(_ s: String) -> [String] { d.detect(s).map { "\($0.kind.rawValue)=\($0.text)" } }

    @Test func findsEmailsWithAndWithoutMailto() {
        #expect(kinds("Write to dana.whitfield@example.com today").contains("email=dana.whitfield@example.com"))
    }

    @Test func findsPhonesAndNeverAlsoCallsThemIDs() {
        let k = kinds("Call +1 (512) 555-0142 after lunch")
        #expect(k.contains { $0.hasPrefix("phone=") && $0.contains("555-0142") })
        #expect(!k.contains { $0.hasPrefix("id=") })
    }

    @Test func findsURLs() {
        #expect(kinds("Join at https://meet.example.com/abc-defg-hij").contains("url=https://meet.example.com/abc-defg-hij"))
    }

    @Test func findsAmountsInSeveralSpellings() {
        #expect(kinds("Total: $1,315.50").contains("amount=$1,315.50"))
        #expect(kinds("Refund of 48.00 USD issued").contains("amount=48.00 USD"))
        #expect(kinds("EUR 12.50 due").contains("amount=EUR 12.50"))
    }

    @Test func findsOrderAndInvoiceIDs() {
        #expect(kinds("Order ORD-2026-48213 confirmed").contains("id=ORD-2026-48213"))
        #expect(kinds("Invoice INV-2087").contains("id=INV-2087"))
        #expect(kinds("Ticket #48213").contains("id=#48213"))
        #expect(kinds("Tracking W1234567").contains("id=W1234567"))
    }

    @Test func separatesTimesFromDates() {
        let k = d.detect("Thursday, October 8, 2026 at 3:00 PM")
        #expect(k.count == 1)
        #expect(k.first?.kind == .date)
        #expect(d.detect("Starts at 3:30 PM").contains { $0.kind == .time && $0.text.contains("3:30") })
    }

    @Test func findsUSAddresses() {
        let k = d.detect("Ship to 1200 Barton Springs Rd, Austin, TX 78704")
        #expect(k.contains { $0.kind == .address && $0.text.contains("Barton Springs") })
    }

    @Test func ignoresPlainWordsAndTinyText() {
        #expect(d.detect("Submit").isEmpty)
        #expect(d.detect("ok").isEmpty)
        #expect(d.detect("COVID-19 guidance").map(\.kind) != [.phone])
    }

    @Test func valuesSkipSecureNodesAndReadEditableValuesOnly() {
        let nodes = [
            Node(key: "a", parent: nil, role: "AXTextField", label: "Email 2", value: "x@example.com", editable: true),
            Node(key: "b", parent: nil, role: "AXTextField", label: "p@example.com", editable: true, states: [.secure]),
            Node(key: "c", parent: nil, role: "AXStaticText", label: "Reach me at y@example.com"),
        ]
        let v = d.values(for: nodes)
        #expect(v == [TypedValue(kind: .email, text: "x@example.com", nodeKey: "a"), TypedValue(kind: .email, text: "y@example.com", nodeKey: "c")])
    }

    /// V4: a pop-up button's option offers a choice; it states no value of the window.
    @Test func valuesSkipAPopUpButtonsOptions() {
        let nodes = [
            Node(key: "m", parent: nil, role: "AXPopUpButton", label: "Contact"),
            Node(key: "m/o", parent: "m", role: "AXMenuItem", label: "front-desk@example.com"),
            Node(key: "c", parent: nil, role: "AXStaticText", label: "Reach me at y@example.com"),
        ]
        #expect(d.values(for: nodes) == [TypedValue(kind: .email, text: "y@example.com", nodeKey: "c")])
    }
}
