import Testing
@testable import CaretScreenCore

@Suite struct ElementKeys {
    @Test func normalizesLabels() {
        #expect(ElementKey.normalizeLabel("  Email Address: ") == "email address")
        #expect(ElementKey.normalizeLabel("Inbox (12)") == "inbox (#)")
        #expect(ElementKey.normalizeLabel("Order ORD-2026-48213") == "order ord-#-#")
        #expect(ElementKey.normalizeLabel("a/b~c") == "a b c")
        #expect(ElementKey.normalizeLabel(String(repeating: "x", count: 100)).count == ElementKey.maxLabel)
        #expect(ElementKey.normalizeLabel("ＦＵＬＬ　ｗｉｄｔｈ") == "full width")
    }

    @Test func buildsWindowKindsAndAppParts() {
        #expect(ElementKey.windowKind(subrole: "AXStandardWindow", identifier: nil) == "standard")
        #expect(ElementKey.windowKind(subrole: "AXDialog", identifier: "") == "dialog")
        #expect(ElementKey.windowKind(subrole: nil, identifier: "Prefs-12") == "standard[prefs-#]")
        #expect(ElementKey.appPart(bundleId: "com.apple.TextEdit", name: "TextEdit") == "com.apple.TextEdit")
        #expect(ElementKey.appPart(bundleId: nil, name: "My Tool") == "unbundled.my-tool")
    }

    private let c = Compactor(app: "dev.caret.fixture", windowKind: "standard")

    private func form(wrapped: Bool = false, extraFirst: Bool = false) -> [RawNode] {
        var fields: [RawNode] = [
            RawNode(role: "AXStaticText", value: "Email"),
            RawNode(role: "AXTextField", title: "Email", value: "", handle: 1),
            RawNode(role: "AXTextField", placeholder: "City"),
            RawNode(role: "AXTextField", placeholder: "City"),
        ]
        if extraFirst { fields.insert(RawNode(role: "AXStaticText", value: "Notice"), at: 0) }
        let group = RawNode(role: "AXGroup", description: "Shipping", children: fields)
        let inner = wrapped ? RawNode(role: "AXGroup", children: [group]) : group
        return [RawNode(role: "AXScrollArea", children: [inner]), RawNode(role: "AXButton", title: "Submit")]
    }

    @Test func keysFollowNamedAncestorsRoleLabelAndOrdinal() {
        let keys = c.compact(windowChildren: form()).nodes.map(\.key)
        #expect(keys == [
            "dev.caret.fixture/standard/group:shipping~0",
            "dev.caret.fixture/standard/group:shipping/statictext:email~0",
            "dev.caret.fixture/standard/group:shipping/textfield:email~0",
            "dev.caret.fixture/standard/group:shipping/textfield:~0",
            "dev.caret.fixture/standard/group:shipping/textfield:~1",
            "dev.caret.fixture/standard/button:submit~0",
        ])
    }

    @Test func unnamedWrappersDoNotMoveKeys() {
        #expect(c.compact(windowChildren: form()).nodes.map(\.key) == c.compact(windowChildren: form(wrapped: true)).nodes.map(\.key))
    }

    @Test func anInsertedSiblingWithAnotherLabelDoesNotMoveKeys() {
        let before = Set(c.compact(windowChildren: form()).nodes.map(\.key))
        let after = Set(c.compact(windowChildren: form(extraFirst: true)).nodes.map(\.key))
        #expect(before.isSubset(of: after))
    }

    @Test func aFieldsKeyDoesNotDependOnItsValue() {
        var a = form(); var b = form()
        a[0].children[0].children[1].value = ""
        b[0].children[0].children[1].value = "typed@example.com"
        #expect(c.compact(windowChildren: a).nodes.map(\.key) == c.compact(windowChildren: b).nodes.map(\.key))
    }

    @Test func identicalSiblingGroupsGetDistinctScopes() {
        let g = { RawNode(role: "AXGroup", description: "Item", children: [RawNode(role: "AXButton", title: "Remove")]) }
        let keys = c.compact(windowChildren: [g(), g()]).nodes.map(\.key)
        #expect(keys == [
            "dev.caret.fixture/standard/group:item~0",
            "dev.caret.fixture/standard/group:item/button:remove~0",
            "dev.caret.fixture/standard/group:item~1",
            "dev.caret.fixture/standard/group:item~1/button:remove~0",
        ])
    }

    @Test func pageAndWindowTitlesStayOutOfKeys() {
        func page(_ title: String) -> [String] {
            let c = Compactor(app: "com.google.Chrome", windowKind: "standard", windowTitle: "\(title) - Google Chrome")
            return c.compact(windowChildren: [
                RawNode(role: "AXGroup", title: "\(title) - Google Chrome", children: [
                    RawNode(role: "AXButton", title: "Reload"),
                    RawNode(role: "AXWebArea", title: title, children: [RawNode(role: "AXTextField", title: "Email")]),
                ]),
            ]).nodes.map(\.key)
        }
        #expect(page("Inbox") == page("Inbox (3) - Order shipped"))
        #expect(page("Inbox").contains("com.google.Chrome/standard/webarea:~0/textfield:email~0") == false)
        #expect(page("Inbox").contains("com.google.Chrome/standard/textfield:email~0"))
    }
}
