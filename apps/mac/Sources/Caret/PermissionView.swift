import SwiftUI

struct PermissionView: View {
    let executablePath: String
    let onOpenSettings: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Image(systemName: "sparkle")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(Color(red: 0.26, green: 0.52, blue: 0.98))
                Text("Reconnect Accessibility")
                    .font(.title3.weight(.semibold))
                Spacer()
            }

            Text("Caret can look enabled in System Settings but still not work. After each install or rebuild, macOS treats this copy as a new app.")
                .font(.callout)
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 8) {
                Text("1. Quit every Caret (Xcode and menu bar).")
                Text("2. In Accessibility, select Caret and click − to remove it.")
                Text("3. Click + and choose:")
                Text(executablePath)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
                Text("4. Turn the new Caret entry on.")
            }
            .font(.callout)

            HStack {
                Button("Not now", action: onDismiss)
                Spacer()
                Button("Open Accessibility Settings", action: onOpenSettings)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 440)
    }
}
