/// A test's precondition broke: the code under test did not do what the test needs to go on (no
/// request sent, no card, a golden line of another type). Thrown, it fails the test. `XCTSkip` here
/// reported such a regression as a skip, which CI counts as a pass (CodeRabbit on PR #10).
struct Unexpected: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
