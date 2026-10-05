import CaretHostCore
import Foundation
import ServiceManagement

/// Caret's launchd agent, registered with SMAppService from Contents/Library/LaunchAgents/dev.caret.host.plist
/// (H4, lead decision 2). Once registered, Caret starts at login; the user turns that off in System Settings ›
/// Login Items.
///
/// Called only for `LaunchRole.handOffToAgent`: a team-signed Caret.app that LaunchServices opened with no home of
/// its own. `register()` adds a login item and starts a process, so nothing else may reach it.
enum LoginAgent {
    static let plistName = "dev.caret.host.plist"
    static let label = "dev.caret.host"

    enum HandOff: Equatable {
        /// The agent is registered and running, or was just started: this copy exits.
        case handedOff(String)
        /// Run here instead, without the page bridge.
        case runHere(String)
    }

    static func handOff() -> HandOff {
        let service = SMAppService.agent(plistName: plistName)
        switch service.status {
        case .enabled:
            // Registered already; the user quit it (exit 0 keeps launchd from restarting it). Start it again.
            return kickstart()
        case .requiresApproval:
            return .runHere("Caret's login item is turned off in System Settings › Login Items")
        case .notRegistered, .notFound:
            do {
                try service.register()
                return .handedOff("registered \(label); launchd starts it now and at each login")
            } catch {
                return .runHere("could not register \(label): \(error.localizedDescription)")
            }
        @unknown default:
            return .runHere("unknown login item status \(service.status.rawValue)")
        }
    }

    private static func kickstart() -> HandOff {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        p.arguments = ["kickstart", "gui/\(getuid())/\(label)"]
        do {
            try p.run()
            p.waitUntilExit()
        } catch {
            return .runHere("could not start \(label): \(error.localizedDescription)")
        }
        return p.terminationStatus == 0 ? .handedOff("started \(label)") : .runHere("launchctl kickstart \(label) exited \(p.terminationStatus)")
    }
}
