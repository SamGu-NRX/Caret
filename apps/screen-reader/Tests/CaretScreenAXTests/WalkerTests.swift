import CaretScreenAX
import Testing

struct WalkerTests {
    @Test func pageTextControlsNeverReadNativeValues() {
        #expect(Walker.shouldReadValue(role: "AXTextField", secure: false, underWebArea: false))
        #expect(!Walker.shouldReadValue(role: "AXTextField", secure: false, underWebArea: true))
        #expect(Walker.shouldReadValue(role: "AXCheckBox", secure: false, underWebArea: true))
        #expect(Walker.shouldReadValue(role: "AXStaticText", secure: false, underWebArea: true))
        #expect(!Walker.shouldReadValue(role: "AXTextField", secure: true, underWebArea: false))
        #expect(!Walker.shouldReadValue(role: "AXButton", secure: false, underWebArea: true))
    }
}
