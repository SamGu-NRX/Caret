import AutocompleteCore

/// A field that may hold a secret gets no ghost text and no writing fix: nothing is generated for it, drawn in it or
/// offered for Tab (audit finding b; the insertion guard refuses a write into one as well, `InsertionGuard`).
enum SecretField {
    /// Secret when Accessibility calls it a secure text field, or KeyType's reader marks it secure entry, a password
    /// field, or a password manager's.
    static func holdsSecret(_ field: FieldState, traits: TextFieldTraits?) -> Bool {
        field.secure || traits?.isSecureTextEntry == true || traits?.isPasswordField == true || traits?.isPasswordManagerContext == true
    }
}
