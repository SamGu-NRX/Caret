import SwiftUI

struct PermissionView: View {
    let onOpenSettings: () -> Void

    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: "sparkle")
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(Color(red: 0.26, green: 0.52, blue: 0.98))
                .padding(.top, 8)

            Text("Caret needs Accessibility")
                .font(.title3.weight(.semibold))

            Text("macOS has to let Caret see the focused field and selected text so the button can appear next to every input and every selection, in every app.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(width: 320)

            Button("Open Accessibility Settings", action: onOpenSettings)
                .keyboardShortcut(.defaultAction)

            Text("Enable Caret, then return here. This window closes on its own.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(28)
        .frame(width: 400)
    }
}
