import ApplicationServices
import AppKit

struct SelectionTarget {
    enum Kind {
        case selection
        case input
    }

    var kind: Kind
    var selectedText: String
    var screenRect: CGRect
    var mouseLocation: CGPoint
    var sourceApp: String?

    var anchor: CGPoint {
        if screenRect.width > 2, screenRect.height > 2 {
            return CGPoint(x: screenRect.maxX + 6, y: screenRect.midY)
        }
        return mouseLocation
    }
}

final class SelectionMonitor {
    var onChange: ((SelectionTarget?) -> Void)?

    private var timer: Timer?
    private var mouseMonitor: Any?
    private var lastSignature: String?
    private var pendingHide: DispatchWorkItem?
    private var lastMouse = NSEvent.mouseLocation

    private let inputRoles: Set<String> = [
        "AXTextField",
        "AXTextArea",
        "AXComboBox",
        "AXSearchField",
        "AXTextInput",
        "AXEditableText",
    ]

    func start() {
        stop()

        mouseMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseUp]) { [weak self] _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                self?.lastMouse = NSEvent.mouseLocation
                self?.inspect()
            }
        }

        let timer = Timer(timeInterval: 0.2, repeats: true) { [weak self] _ in
            self?.inspect()
        }
        timer.tolerance = 0.05
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        inspect()
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        pendingHide?.cancel()
        if let mouseMonitor {
            NSEvent.removeMonitor(mouseMonitor)
            self.mouseMonitor = nil
        }
    }

    private func inspect() {
        guard AXIsProcessTrusted() else {
            publish(nil)
            return
        }

        guard let app = NSWorkspace.shared.frontmostApplication,
              app.processIdentifier != ProcessInfo.processInfo.processIdentifier
        else {
            publish(nil)
            return
        }

        let mouse = lastMouse
        let element = AXHelpers.focusedElement(in: app)
        let role = element.flatMap { AXHelpers.stringValue($0, kAXRoleAttribute as CFString) } ?? ""
        let subrole = element.flatMap { AXHelpers.stringValue($0, kAXSubroleAttribute as CFString) } ?? ""

        if role == "AXSecureTextField" || subrole == "AXSecureTextField" {
            publish(nil)
            return
        }

        let selected = element.flatMap { AXHelpers.stringValue($0, kAXSelectedTextAttribute as CFString) } ?? ""
        let selectionBounds = element.flatMap { AXHelpers.selectedTextBounds($0) }
        let frame = element.flatMap { AXHelpers.frame($0) }

        if !selected.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            publish(
                SelectionTarget(
                    kind: .selection,
                    selectedText: selected,
                    screenRect: selectionBounds ?? CGRect(x: mouse.x, y: mouse.y, width: 1, height: 1),
                    mouseLocation: mouse,
                    sourceApp: app.localizedName
                )
            )
            return
        }

        if isTextInput(role: role, subrole: subrole, element: element) {
            publish(
                SelectionTarget(
                    kind: .input,
                    selectedText: "",
                    screenRect: frame ?? CGRect(x: mouse.x, y: mouse.y, width: 1, height: 1),
                    mouseLocation: mouse,
                    sourceApp: app.localizedName
                )
            )
            return
        }

        publish(nil)
    }

    private func isTextInput(role: String, subrole: String, element: AXUIElement?) -> Bool {
        if inputRoles.contains(role) || inputRoles.contains(subrole) {
            return true
        }

        let description = (element.flatMap { AXHelpers.stringValue($0, kAXRoleDescriptionAttribute as CFString) } ?? "")
            .lowercased()
        return description.contains("text field")
            || description.contains("text area")
            || description.contains("search field")
            || description.contains("combo box")
            || description.contains("editor")
    }

    private func publish(_ target: SelectionTarget?) {
        let signature = target.map {
            "\($0.kind)-\(Int($0.anchor.x))-\(Int($0.anchor.y))-\($0.sourceApp ?? "")"
        } ?? "nil"

        if signature == lastSignature { return }

        if target == nil {
            guard pendingHide == nil else { return }
            let work = DispatchWorkItem { [weak self] in
                guard let self else { return }
                self.lastSignature = "nil"
                self.pendingHide = nil
                self.onChange?(nil)
            }
            pendingHide = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2, execute: work)
            return
        }

        pendingHide?.cancel()
        pendingHide = nil
        lastSignature = signature
        onChange?(target)
    }
}
