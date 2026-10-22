import AutocompleteCore
import CaretHostCore
import XCTest
@testable import CaretHost

/// Audit finding b: no ghost text or writing fix is ever offered in a field that may hold a secret.
final class SecretFieldTests: XCTestCase {
    func field(secure: Bool) -> FieldState {
        FieldState(
            identity: TargetIdentity(pid: 42, bundleID: "com.example.Login", windowID: "w", elementID: "e", elementRevision: UTF16Text.digest("hunter")),
            value: "hunter", selection: .caret(6), role: "AXTextField", secure: secure
        )
    }

    func testASecureTextFieldHoldsASecret() {
        XCTAssertTrue(SecretField.holdsSecret(field(secure: true), traits: nil))
        XCTAssertTrue(SecretField.holdsSecret(field(secure: true), traits: TextFieldTraits()))
    }

    func testKeyTypesSecretTraitsCountToo() {
        for traits in [TextFieldTraits(isSecureTextEntry: true), TextFieldTraits(isPasswordField: true), TextFieldTraits(isPasswordManagerContext: true)] {
            XCTAssertTrue(SecretField.holdsSecret(field(secure: false), traits: traits), "\(traits)")
        }
    }

    func testAnOrdinaryFieldDoesNot() {
        XCTAssertFalse(SecretField.holdsSecret(field(secure: false), traits: TextFieldTraits()))
        XCTAssertFalse(SecretField.holdsSecret(field(secure: false), traits: nil))
    }
}
