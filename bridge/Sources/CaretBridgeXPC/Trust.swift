import AppKit
import CaretPageProtocol
import Darwin
import Foundation
import Security

/// Who may be on each end of the bridge's XPC connection, as code-signing requirements macOS checks itself.
///
/// The bridge and the host are signed by one Apple Development team. The host accepts a connection only from code that
/// is that team's `dev.caret.bridge` (NSXPCConnection.setCodeSigningRequirement on the accepted connection), and the
/// bridge talks only to that team's `dev.caret.host` (the same call on its own connection), so a process that took the
/// service name first cannot pose as the host. A signed bridge can still be started by any process of the user's, so
/// the host also requires the bridge's parent to be a browser whose own signature it knows (`browserRequirements`).
public enum BridgeTrust {
    /// The team in the leaf certificate's OU. Sam's Apple Development identity "focus.sgu" (certificate SHA-1 472BDE15…FD75).
    public static let teamId = "DWGXWVUR2B"
    public static let bridgeIdentifier = "dev.caret.bridge"
    /// Caret.app's bundle identifier (apps/caret/Bundle/Info.plist on v2/host).
    public static let hostIdentifier = "dev.caret.host"
    /// launchd's name for the host's service. A bridge may be pointed at another name (CARET_BRIDGE_SERVICE, for tests):
    /// the name decides nothing, the host requirement does.
    public static let machService = "dev.caret.host.page-bridge"

    /// Apple-issued signing identity, this identifier, this team.
    public static func requirement(identifier: String, team: String = teamId) -> String {
        "anchor apple generic and identifier \"\(identifier)\" and certificate leaf[subject.OU] = \"\(team)\""
    }

    public static var bridgeRequirement: String { requirement(identifier: bridgeIdentifier) }
    public static var hostRequirement: String { requirement(identifier: hostIdentifier) }

    /// The browsers a bridge may be the child of, as each one's designated requirement (`codesign -d -r-`, 2026-10-04):
    /// Google Chrome's channels and Helium. Chrome for Testing is ad hoc signed, so a test host names it by cdhash.
    public static let browserRequirements = [
        "(identifier \"com.google.Chrome\" or identifier \"com.google.Chrome.beta\" or identifier \"com.google.Chrome.dev\" or identifier \"com.google.Chrome.canary\") and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = EQHXZ8M8AV",
        "identifier \"net.imput.helium\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = S4Q33XPHB4",
    ]
}

public enum ProcessTrust {
    /// Whether running process `pid` is valid code that satisfies `requirement`. False when the process is gone, the
    /// requirement does not parse, or the signature does not hold.
    public static func satisfies(pid: pid_t, requirement: String) -> Bool {
        var code: SecCode?
        guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid: pid] as CFDictionary, [], &code) == errSecSuccess, let code else { return false }
        var req: SecRequirement?
        guard SecRequirementCreateWithString(requirement as CFString, [], &req) == errSecSuccess, let req else { return false }
        return SecCodeCheckValidity(code, [], req) == errSecSuccess
    }

    /// Whether `requirement` parses as a code requirement.
    public static func parses(_ requirement: String) -> Bool {
        var req: SecRequirement?
        return SecRequirementCreateWithString(requirement as CFString, [], &req) == errSecSuccess
    }

    /// The parent of `pid`, or nil when the process is gone.
    public static func parent(of pid: pid_t) -> pid_t? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
        return pid_t(info.pbi_ppid)
    }

    /// `pid` as the page wire names a browser. LaunchServices does not know a headless browser, so the bundle is also
    /// found from the executable's path (".../Name.app/Contents/MacOS/Name").
    public static func browserRef(pid: pid_t) -> BrowserRef {
        let app = NSRunningApplication(processIdentifier: pid)
        var path = ""
        var buf = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        if proc_pidpath(pid, &buf, UInt32(buf.count)) > 0 { path = String(decoding: buf.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self) }
        var bundle: Bundle?
        if let r = path.range(of: ".app/Contents/MacOS/", options: .backwards) { bundle = Bundle(path: String(path[..<r.lowerBound]) + ".app") }
        let bundleId = app?.bundleIdentifier ?? bundle?.bundleIdentifier ?? "unknown"
        var name = app?.localizedName ?? (bundle?.object(forInfoDictionaryKey: "CFBundleName") as? String) ?? ""
        if name.isEmpty { name = (path as NSString).lastPathComponent }
        return BrowserRef(pid: pid, bundleId: bundleId, name: name.isEmpty ? "unknown" : name)
    }

    /// The browser that launched bridge `pid`: its parent, when that parent satisfies one of `requirements`; else why not.
    ///
    /// Pids are numbers, not identities, so the parent is read again after its signature is checked: a parent that
    /// exited meanwhile reparents the bridge (to launchd, pid 1), and a different number is refused. The bridge itself
    /// is alive throughout (it is waiting on open's reply), so its own pid cannot be reused. The XPC peer's audit token
    /// would bind this tighter, but NSXPCConnection exposes it only through private API (W3 review #14).
    ///
    /// `parentOf`, `check` and `describe` are the process lookups; tests replace them to play a parent that exits
    /// between the signature check and the second read (W4).
    public static func launchingBrowser(
        of pid: pid_t, requirements: [String],
        parentOf: (pid_t) -> pid_t? = { parent(of: $0) },
        check: (pid_t, String) -> Bool = { satisfies(pid: $0, requirement: $1) },
        describe: (pid_t) -> BrowserRef = { browserRef(pid: $0) }
    ) -> Result<BrowserRef, BridgeRefusal> {
        guard let ppid = parentOf(pid), ppid > 1 else { return .failure(.parent("the bridge has no parent process (its browser exited)")) }
        guard requirements.contains(where: { check(ppid, $0) }) else {
            return .failure(.parent("the bridge's parent, process \(ppid), is not a browser Caret knows by its signature"))
        }
        let browser = describe(ppid)
        guard parentOf(pid) == ppid else { return .failure(.parent("the bridge's parent changed while Caret checked it")) }
        return .success(browser)
    }
}

/// Why the host refused a bridge, or a bridge its host.
public enum BridgeRefusal: Error, Equatable, CustomStringConvertible, Sendable {
    case parent(String)
    case extensionId(String)
    case helper(String)
    case xpc(String)
    case timeout(String)
    /// The host's own answer to open: one of the above, as it said it.
    case host(String)

    public var description: String {
        switch self {
        case let .parent(s), let .extensionId(s), let .helper(s), let .xpc(s), let .timeout(s): s
        case let .host(s): "the Caret host refused: \(s)"
        }
    }
}
