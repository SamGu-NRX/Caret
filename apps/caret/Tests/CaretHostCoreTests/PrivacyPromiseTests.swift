import CaretHostCore
import XCTest

/// The promise is shown word for word, so the split has one right answer: every block in order, nothing dropped or
/// changed, and headings only where the text has a one-line block with no closing punctuation. The texts are the
/// tests' own; the approved promise is the build's to check (scripts/privacy_gate.sh), and its words will change.
final class PrivacyPromiseTests: XCTestCase {
    func testHeadingsAndParagraphsInOrder() throws {
        let text = "What it sends\n\nShort pieces of a screen, such as a label.\n\nWho gets it\n\nA model run by someone.\n\nAnother model, \"hosted\" elsewhere."
        let promise = try XCTUnwrap(PrivacyPromise(text))
        XCTAssertEqual(promise.blocks, [
            .heading("What it sends"), .paragraph("Short pieces of a screen, such as a label."),
            .heading("Who gets it"), .paragraph("A model run by someone."), .paragraph("Another model, \"hosted\" elsewhere."),
        ])
    }

    func testJoiningTheBlocksGivesBackTheTextExactly() throws {
        for text in ["One paragraph.", "Heading\n\nBody.\n", "A\n\n\n\nB.", "  Leading space\n\nTrailing space.  ", "Line one\nline two\n\nEnd."] {
            let promise = try XCTUnwrap(PrivacyPromise(text), text)
            XCTAssertEqual(promise.blocks.map(\.text).joined(separator: PrivacyPromise.separator), text, text)
        }
    }

    func testOnlyAOneLineBlockWithoutClosingPunctuationIsAHeading() throws {
        let cases: [(String, Bool)] = [
            ("Who receives it", true),
            ("A sentence.", false), ("Is it a question?", false), ("A list:", false), ("Ends in a quote\u{201D}", false),
            ("Two lines\nwith no period", false), ("2,000", false), ("(see below)", false),
        ]
        for (block, heading) in cases {
            let promise = try XCTUnwrap(PrivacyPromise("First.\n\n" + block))
            XCTAssertEqual(promise.blocks.last, heading ? .heading(block) : .paragraph(block), block)
        }
    }

    /// Trailing whitespace is not punctuation: the last character that is not whitespace decides, and the block keeps
    /// its whitespace when shown.
    func testTrailingWhitespaceDoesNotMakeAParagraphAHeading() throws {
        let cases: [(String, Bool)] = [
            ("A sentence.  ", false), ("A sentence.\n", false), ("A sentence.\t \n", false),
            ("Who receives it  ", true), ("Who receives it\n", true),
        ]
        for (block, heading) in cases {
            let text = "First.\n\n" + block
            let promise = try XCTUnwrap(PrivacyPromise(text))
            XCTAssertEqual(promise.blocks.last, heading ? .heading(block) : .paragraph(block), block.debugDescription)
            XCTAssertEqual(promise.blocks.map(\.text).joined(separator: PrivacyPromise.separator), text)
        }
    }

    func testEmptyOrWhitespaceTextIsNoPromise() {
        for text in ["", " ", "\n\n", "\t\n "] {
            XCTAssertNil(PrivacyPromise(text), "\(text.debugDescription) must read as missing, never as an empty promise")
        }
    }
}
