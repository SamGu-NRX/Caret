import Testing
@testable import CaretScreenCore

@Suite struct Compaction {
    private let c = Compactor(app: "app", windowKind: "standard")

    @Test func dropsDefaultStatesAndValuesEqualToTheName() {
        let r = c.compact(windowChildren: [
            RawNode(role: "AXButton", title: "OK"),
            RawNode(role: "AXPopUpButton", title: "Size", value: "Size"),
            RawNode(role: "AXCheckBox", title: "Remember", enabled: false, checked: true),
        ])
        #expect(r.nodes[0].states.isEmpty)
        #expect(r.nodes[1].value == nil)
        #expect(r.nodes[2].states == [.disabled, .checked])
    }

    @Test func keepsAnEditableValueThatRepeatsTheLabel() {
        let r = c.compact(windowChildren: [RawNode(role: "AXTextField", title: "City", value: "City")])
        #expect(r.nodes[0].value == "City")
    }

    @Test func putsStaticTextInTheLabel() {
        let r = c.compact(windowChildren: [RawNode(role: "AXStaticText", value: "Order total: $48.20")])
        #expect(r.nodes[0].label == "Order total: $48.20")
        #expect(r.nodes[0].value == nil)
    }

    @Test func collapsesUnnamedContainersAndDropsEmptyLeavesAndChrome() {
        let r = c.compact(windowChildren: [
            RawNode(role: "AXGroup", children: [
                RawNode(role: "AXGroup", children: [RawNode(role: "AXStaticText", value: "Hello")]),
                RawNode(role: "AXImage"),
                RawNode(role: "AXStaticText", value: "   "),
            ]),
            RawNode(role: "AXScrollBar", children: [RawNode(role: "AXButton", title: "Up")]),
            RawNode(role: "AXMenuBar", children: [RawNode(role: "AXMenuBarItem", title: "File")]),
        ])
        #expect(r.nodes.map(\.key) == ["app/standard/statictext:hello~0"])
        #expect(r.nodes[0].parent == nil)
    }

    @Test func linksChildrenToTheNearestKeptAncestor() {
        let r = c.compact(windowChildren: [
            RawNode(role: "AXGroup", title: "Billing", children: [RawNode(role: "AXGroup", children: [RawNode(role: "AXTextField", title: "Card name")])]),
        ])
        #expect(r.nodes[1].parent == r.nodes[0].key)
    }

    @Test func neverWalksIntoOrKeepsTheValueOfASecureField() {
        let r = c.compact(windowChildren: [
            RawNode(role: "AXTextField", subrole: "AXSecureTextField", title: "Password", value: "hunter2", secure: true,
                    children: [RawNode(role: "AXStaticText", value: "hunter2")]),
        ])
        #expect(r.nodes.count == 1)
        #expect(r.nodes[0].value == nil)
        #expect(r.nodes[0].states == [.secure])
        #expect(r.nodes[0].editable)
    }

    @Test func reportsTheFocusedKeyAndTheTitleElementLabel() {
        let r = c.compact(windowChildren: [RawNode(role: "AXTextField", titleElementText: "Phone", focused: true)])
        #expect(r.focusedKey == "app/standard/textfield:phone~0")
        #expect(r.nodes[0].label == "Phone")
    }

    private func tree(_ email: String, notes: String = "") -> [RawNode] {
        [RawNode(role: "AXGroup", title: "Contact", children: [
            RawNode(role: "AXTextField", title: "Email", value: email, handle: 2),
            RawNode(role: "AXGroup", title: "Extra", children: [RawNode(role: "AXTextArea", title: "Notes", value: notes)], handle: 3),
        ], handle: 1)]
    }

    @Test func aSubtreeWalkReproducesTheFullWalksKeys() throws {
        let full = c.compact(windowChildren: tree("a@example.com", notes: "x"))
        let leafCtx = try #require(full.contexts[2])
        #expect(leafCtx.leaf)
        let leaf = try #require(c.compactSubtree(RawNode(role: "AXTextField", title: "Email", value: "b@example.com"), context: leafCtx))
        #expect(leaf.nodes.map(\.key) == [leafCtx.key])
        #expect(leaf.nodes[0].value == "b@example.com")
        #expect(leaf.nodes[0].parent == "app/standard/group:contact~0")

        let groupCtx = try #require(full.contexts[3])
        #expect(groupCtx.named && !groupCtx.leaf)
        let sub = try #require(c.compactSubtree(RawNode(role: "AXGroup", title: "Extra", children: [RawNode(role: "AXTextArea", title: "Notes", value: "y")]), context: groupCtx))
        let fullAfter = c.compact(windowChildren: tree("a@example.com", notes: "y"))
        #expect(sub.nodes == Array(fullAfter.nodes.suffix(2)))
    }

    @Test func aSubtreeWalkGivesUpWhenTheRootsLabelChanged() throws {
        let full = c.compact(windowChildren: [RawNode(role: "AXStaticText", value: "3 unread", handle: 1)])
        let ctx = try #require(full.contexts[1])
        #expect(c.compactSubtree(RawNode(role: "AXStaticText", value: "4 unread"), context: ctx) != nil) // digits are masked
        #expect(c.compactSubtree(RawNode(role: "AXStaticText", value: "Read"), context: ctx) == nil)
    }
}
