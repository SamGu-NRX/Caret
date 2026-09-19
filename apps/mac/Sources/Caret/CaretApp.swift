import AppKit
import Carbon
import SwiftUI

struct MeetingOption: Decodable, Identifiable {
    let id: String
    let start: String
    let end: String
    let source: String
}

struct Preview: Decodable {
    let run_id: String
    let subject: String
    let thread_body: String
    let options: [MeetingOption]
    let draft: String
    let evidence: [String]
    let notice: String
}

@MainActor
final class Model: ObservableObject {
    @Published var preview: Preview?
    @Published var selection = ""
    @Published var busy = false
    @Published var message = ""
    @Published var held = false
    @Published var confirmed = false
    private let root: String

    init(root: String) { self.root = root }

    func load() {
        execute(["preview", "--fixture", "fixtures/meeting.json"]) { data in
            self.preview = try JSONDecoder().decode(Preview.self, from: data)
            self.selection = self.preview?.options.first?.id ?? ""
            self.held = false
            self.confirmed = false
            self.message = ""
        }
    }

    func hold() {
        guard let preview else { return }
        execute(["hold", preview.run_id]) { _ in
            self.held = true
            self.message = "Tentative holds saved in local SQLite. Your calendar is unchanged."
        }
    }

    func confirm() {
        guard let preview, !selection.isEmpty else { return }
        execute(["confirm", preview.run_id, selection]) { _ in
            self.held = false
            self.confirmed = true
            self.message = "Selected local hold confirmed; the other local holds were released."
        }
    }

    private func execute(_ arguments: [String], completion: @escaping (Data) throws -> Void) {
        guard !busy else { return }
        busy = true
        let root = root
        let python = Bundle.main.object(forInfoDictionaryKey: "CaretPythonExecutable") as? String
        Task {
            do {
                let data = try await Task.detached {
                    let process = Process()
                    process.executableURL = URL(fileURLWithPath: python ?? "/usr/bin/env")
                    process.arguments = (python == nil ? ["python3"] : []) + ["-m", "caret"] + arguments
                    process.currentDirectoryURL = URL(fileURLWithPath: root)
                    let output = Pipe()
                    process.standardOutput = output
                    process.standardError = output
                    try process.run()
                    let data = output.fileHandleForReading.readDataToEndOfFile()
                    process.waitUntilExit()
                    guard process.terminationStatus == 0 else {
                        throw NSError(domain: "Caret", code: Int(process.terminationStatus), userInfo: [
                            NSLocalizedDescriptionKey: String(data: data, encoding: .utf8) ?? "The local core failed."
                        ])
                    }
                    return data
                }.value
                try completion(data)
            } catch {
                self.message = error.localizedDescription
            }
            self.busy = false
        }
    }
}

struct CaretView: View {
    @ObservedObject var model: Model

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Image(systemName: "cursorarrow.rays")
                Text("Caret").font(.headline)
                Spacer()
                Text("Sample workspace").font(.caption).foregroundStyle(.secondary)
            }
            Text("Find three times to meet, with room for travel.")
                .font(.title3).fontWeight(.medium)
            if let preview = model.preview {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        Text(preview.notice).font(.caption).foregroundStyle(.secondary)
                        ForEach(preview.options) { option in
                            Button {
                                model.selection = option.id
                            } label: {
                                HStack(alignment: .top, spacing: 12) {
                                    Image(systemName: model.selection == option.id ? "largecircle.fill.circle" : "circle")
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(option.start).fontWeight(.medium)
                                        Text("Until \(option.end)").font(.caption)
                                        Text(option.source).font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                }.padding(10).contentShape(Rectangle())
                            }.buttonStyle(.plain)
                                .accessibilityValue(model.selection == option.id ? "Selected" : "Not selected")
                                .disabled(model.confirmed || model.busy)
                        }
                        Divider()
                        Text("Draft").font(.headline)
                        Text(preview.draft.isEmpty ? "No supported options. No draft was created." : preview.draft)
                            .textSelection(.enabled)
                        DisclosureGroup("Evidence") {
                            VStack(alignment: .leading, spacing: 8) {
                                Text(preview.subject).fontWeight(.medium)
                                Text(preview.thread_body)
                                ForEach(preview.evidence, id: \.self) { Text($0) }
                            }.font(.caption).padding(.top, 8).textSelection(.enabled)
                        }
                    }
                }
                HStack {
                    Button("Send email") {}.disabled(true).help("Gmail is not connected in this starter.")
                    Spacer()
                    if model.confirmed {
                        Text("Local choice confirmed").foregroundStyle(.secondary)
                    } else if model.held {
                        Button("Confirm local choice", action: model.confirm).keyboardShortcut(.return, modifiers: [])
                    } else {
                        Button("Save local holds", action: model.hold)
                            .disabled(preview.options.isEmpty).keyboardShortcut(.return, modifiers: [])
                    }
                }.disabled(model.busy)
            } else {
                Text("Open the sample thread, calculate available slots and inspect the evidence.")
                    .foregroundStyle(.secondary)
                Button("Preview sample", action: model.load).keyboardShortcut(.return, modifiers: []).disabled(model.busy)
            }
            if model.busy { ProgressView().controlSize(.small) }
            if !model.message.isEmpty { Text(model.message).font(.caption).textSelection(.enabled) }
            HStack {
                Text("⌃⌥Space to open · Esc to dismiss").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Quit") { NSApp.terminate(nil) }.keyboardShortcut("q")
            }
        }
        .padding(24).frame(width: 560, height: model.preview == nil ? 260 : 680)
        .onExitCommand { NSApp.keyWindow?.orderOut(nil) }
    }
}

final class CaretPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var panel: NSPanel?
    private var hotKey: EventHotKeyRef?
    private var statusItem: NSStatusItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let root = CommandLine.arguments.dropFirst().first
            ?? Bundle.main.object(forInfoDictionaryKey: "CaretProjectRoot") as? String
            ?? FileManager.default.currentDirectoryPath
        let model = Model(root: root)
        let panel = CaretPanel(contentRect: .zero, styleMask: [.titled, .closable, .fullSizeContentView], backing: .buffered, defer: false)
        panel.title = "Caret"
        panel.titlebarAppearsTransparent = true
        panel.isReleasedWhenClosed = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.contentView = NSHostingView(rootView: CaretView(model: model))
        self.panel = panel

        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "Caret"
        item.button?.target = self
        item.button?.action = #selector(show)
        statusItem = item

        var event = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let handlerStatus = InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
            Task { @MainActor in (NSApp.delegate as? AppDelegate)?.show() }
            return noErr
        }, 1, &event, nil, nil)
        let keyStatus = RegisterEventHotKey(UInt32(kVK_Space), UInt32(controlKey | optionKey), EventHotKeyID(signature: 0x43525431, id: 1), GetApplicationEventTarget(), 0, &hotKey)
        if handlerStatus != noErr || keyStatus != noErr {
            model.message = "The shortcut could not be registered. Open Caret from its menu bar item."
        }
        show()
    }

    @objc func show() {
        panel?.center()
        panel?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let hotKey { UnregisterEventHotKey(hotKey) }
    }
}

@main
struct CaretMain {
    @MainActor static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.setActivationPolicy(.accessory)
        application.delegate = delegate
        withExtendedLifetime(delegate) { application.run() }
    }
}
