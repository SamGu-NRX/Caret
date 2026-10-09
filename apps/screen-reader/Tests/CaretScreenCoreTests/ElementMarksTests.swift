// S1 audit #6 (ElementMarks) and #14 (FocusCheck): the rules the reader applies around AX calls, on stand-ins.
import Testing
@testable import CaretScreenCore

/// A stand-in for an Accessibility element: equal only to itself, whatever its key, role or value.
private struct Element: Equatable { let id: Int }

@Suite struct ElementMarksTests {
    @Test func restoresOnlyIntoTheElementTheWriteRecorded() {
        var marks = ElementMarks<Element>()
        let name = Element(id: 1), email = Element(id: 2)
        marks.record("m-name", name)
        marks.record("m-email", email)
        #expect(marks.refusal(sameAs: "m-name", current: name) == nil)
        // A sibling that took the field's key: same place, another element.
        #expect(marks.refusal(sameAs: "m-name", current: Element(id: 3)) == "another element now has this key")
        #expect(marks.refusal(sameAs: "m-name", current: email) == "another element now has this key")
        // A mark this table never recorded: a reader that restarted, or a worker made for a new process.
        #expect(marks.refusal(sameAs: "m-other", current: name)?.hasPrefix("the reader holds no element under this mark") == true)
    }

    @Test func keepsTheNewestMarksAndRefusesOnesItLetGo() {
        var marks = ElementMarks<Element>()
        let n = ElementMarks<Element>.limit
        for i in 0..<(n + 3) { marks.record("m\(i)", Element(id: i)) }
        #expect(marks.count == n)
        #expect(marks.refusal(sameAs: "m0", current: Element(id: 0)) != nil)
        #expect(marks.refusal(sameAs: "m\(n + 2)", current: Element(id: n + 2)) == nil)
        // Recording a mark again replaces its element and does not grow the table.
        marks.record("m\(n + 2)", Element(id: -1))
        #expect(marks.count == n)
        #expect(marks.refusal(sameAs: "m\(n + 2)", current: Element(id: -1)) == nil)
    }
}

@Suite struct FocusCheckTests {
    @Test func writesOnlyWhileTheFieldItFocusedStillHasFocusInItsWindow() {
        // Focus where the reader put it: the app agrees, or its focus is in another window (the target is not key).
        #expect(FocusCheck.refusal(elementFocused: true, inTargetWindow: true, appFocus: .target) == nil)
        #expect(FocusCheck.refusal(elementFocused: true, inTargetWindow: true, appFocus: .otherWindow) == nil)
        #expect(FocusCheck.refusal(elementFocused: true, inTargetWindow: true, appFocus: .unknown) == nil)
        // A page handler moved focus to another field.
        #expect(FocusCheck.refusal(elementFocused: false, inTargetWindow: true, appFocus: .elsewhereInWindow) == "focus moved off the field after Caret focused it")
        #expect(FocusCheck.refusal(elementFocused: true, inTargetWindow: true, appFocus: .elsewhereInWindow) == "focus is on another element of the window")
        #expect(FocusCheck.refusal(elementFocused: false, inTargetWindow: true, appFocus: .target) == "focus moved off the field after Caret focused it")
        // The field left the window, or nothing can be read: refused, never guessed.
        #expect(FocusCheck.refusal(elementFocused: true, inTargetWindow: false, appFocus: .target) == "the field is no longer in the window Caret meant")
        #expect(FocusCheck.refusal(elementFocused: nil, inTargetWindow: true, appFocus: .target) == "the reader cannot read whether the field has focus")
        #expect(FocusCheck.refusal(elementFocused: true, inTargetWindow: nil, appFocus: .target) == "the reader cannot read which window the field is in")
    }
}
