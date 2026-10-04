import Foundation

// The Swift mirror of helper/src/protocol.ts, "the page engine" section. The zod schemas are the source of truth;
// every line of helper/fixtures/golden/page.ndjson must decode here (GoldenPageTests). The bridge itself relays
// lines without decoding them (it checks only their type, Relay.swift), so this mirror is for Swift code that reads
// the page wire and for keeping the two sides honest.

public enum GrantScope: Codable, Equatable, Sendable {
    case native(pid: Int, windowId: String)
    case page(engine: String, tabId: Int, frameId: Int, origin: String, navGen: Int)

    private enum K: String, CodingKey { case kind, pid, windowId, engine, tabId, frameId, origin, navGen }
    public init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "native": self = .native(pid: try c.decode(Int.self, forKey: .pid), windowId: try c.decode(String.self, forKey: .windowId))
        case "page":
            self = .page(engine: try c.decode(String.self, forKey: .engine), tabId: try c.decode(Int.self, forKey: .tabId),
                         frameId: try c.decode(Int.self, forKey: .frameId), origin: try c.decode(String.self, forKey: .origin),
                         navGen: try c.decode(Int.self, forKey: .navGen))
        case let k: throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown grant scope \(k)")
        }
    }
    public func encode(to e: Encoder) throws {
        var c = e.container(keyedBy: K.self)
        switch self {
        case let .native(pid, windowId):
            try c.encode("native", forKey: .kind); try c.encode(pid, forKey: .pid); try c.encode(windowId, forKey: .windowId)
        case let .page(engine, tabId, frameId, origin, navGen):
            try c.encode("page", forKey: .kind); try c.encode(engine, forKey: .engine); try c.encode(tabId, forKey: .tabId)
            try c.encode(frameId, forKey: .frameId); try c.encode(origin, forKey: .origin); try c.encode(navGen, forKey: .navGen)
        }
    }
}

public struct ScopedActGrant: Codable, Equatable, Sendable {
    public var v: Int, taskId: String, scope: GrantScope, at: Int64, expires: Int64
}

public struct ActRevoke: Codable, Equatable, Sendable {
    public var v: Int, taskId: String, at: Int64
}

public enum PageControlKind: String, Codable, Sendable, CaseIterable {
    case text, email, tel, url, number, search, date, time, datetime, month, week, textarea
    case select, checkbox, radio, combobox, button, link, file, contenteditable, range, color
}

public struct PageOption: Codable, Equatable, Sendable { public var value: String, label: String, selected: Bool }

public struct PageControl: Codable, Equatable, Sendable {
    public var id: String, key: String, strongKey: String?, kind: PageControlKind, role: String, name: String
    public var value: String?, checked: Bool?, options: [PageOption]?, form: String?, rect: [Double]
    public var required: Bool?, disabled: Bool?, invalid: Bool?, shadow: String?
}

public struct PageIFrame: Codable, Equatable, Sendable { public var src: String, rect: [Double] }

public struct PageFrame: Codable, Equatable, Sendable {
    public var frameId: Int, parentFrameId: Int, documentId: String, origin: String, path: String, navGen: Int
    public var title: String, headings: [String], controls: [PageControl], iframes: [PageIFrame]
    public var excluded: [String: Int], truncated: Bool
}

public struct PageFocus: Codable, Equatable, Sendable { public var frameId: Int, id: String, selection: [Int]? }
public struct PageMissing: Codable, Equatable, Sendable { public var frameId: Int, reason: String }

public struct PageSnapshot: Codable, Equatable, Sendable {
    public var v: Int, id: String, at: Int64, tabId: Int, browserWindowId: Int, active: Bool, title: String
    public var frames: [PageFrame], missing: [PageMissing], focused: PageFocus?
}

/// The element a mutating page verb names, as the last walk named it.
public struct PageTarget: Equatable, Sendable {
    public var tabId: Int, frameId: Int, documentId: String, id: String, control: PageControlKind, name: String, taskId: String
}

/// The file pageAttachFile carries: its bytes in `data`, base64 (W2).
public struct PageFile: Codable, Equatable, Sendable { public var name: String, type: String, size: Int, sha256: String, data: String }

public enum PageVerb: Codable, Equatable, Sendable {
    case walk(tabId: Int?)
    case write(PageTarget, expect: String, value: String)
    case press(PageTarget)
    case select(PageTarget, expect: String, value: String)
    case chooseOption(PageTarget, expect: String, value: String)
    case setChecked(PageTarget, checked: Bool)
    case attachFile(PageTarget, file: PageFile)

    private enum K: String, CodingKey { case kind, tabId, frameId, documentId, id, control, name, taskId, expect, value, checked, file }
    public init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        let kind = try c.decode(String.self, forKey: .kind)
        if kind == "pageWalk" { self = .walk(tabId: try c.decodeIfPresent(Int.self, forKey: .tabId)); return }
        let t = PageTarget(tabId: try c.decode(Int.self, forKey: .tabId), frameId: try c.decode(Int.self, forKey: .frameId),
                           documentId: try c.decode(String.self, forKey: .documentId), id: try c.decode(String.self, forKey: .id),
                           control: try c.decode(PageControlKind.self, forKey: .control), name: try c.decode(String.self, forKey: .name),
                           taskId: try c.decode(String.self, forKey: .taskId))
        switch kind {
        case "pageWrite": self = .write(t, expect: try c.decode(String.self, forKey: .expect), value: try c.decode(String.self, forKey: .value))
        case "pagePress": self = .press(t)
        case "pageSelect": self = .select(t, expect: try c.decode(String.self, forKey: .expect), value: try c.decode(String.self, forKey: .value))
        case "pageChooseOption": self = .chooseOption(t, expect: try c.decode(String.self, forKey: .expect), value: try c.decode(String.self, forKey: .value))
        case "pageSetChecked": self = .setChecked(t, checked: try c.decode(Bool.self, forKey: .checked))
        case "pageAttachFile": self = .attachFile(t, file: try c.decode(PageFile.self, forKey: .file))
        default: throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown page verb \(kind)")
        }
    }
    public func encode(to e: Encoder) throws {
        var c = e.container(keyedBy: K.self)
        func target(_ kind: String, _ t: PageTarget) throws {
            try c.encode(kind, forKey: .kind); try c.encode(t.tabId, forKey: .tabId); try c.encode(t.frameId, forKey: .frameId)
            try c.encode(t.documentId, forKey: .documentId); try c.encode(t.id, forKey: .id); try c.encode(t.control, forKey: .control)
            try c.encode(t.name, forKey: .name); try c.encode(t.taskId, forKey: .taskId)
        }
        switch self {
        case let .walk(tabId): try c.encode("pageWalk", forKey: .kind); try c.encode(tabId, forKey: .tabId)
        case let .write(t, expect, value): try target("pageWrite", t); try c.encode(expect, forKey: .expect); try c.encode(value, forKey: .value)
        case let .press(t): try target("pagePress", t)
        case let .select(t, expect, value): try target("pageSelect", t); try c.encode(expect, forKey: .expect); try c.encode(value, forKey: .value)
        case let .chooseOption(t, expect, value): try target("pageChooseOption", t); try c.encode(expect, forKey: .expect); try c.encode(value, forKey: .value)
        case let .setChecked(t, checked): try target("pageSetChecked", t); try c.encode(checked, forKey: .checked)
        case let .attachFile(t, file): try target("pageAttachFile", t); try c.encode(file, forKey: .file)
        }
    }
}

public struct PageCommand: Codable, Equatable, Sendable { public var v: Int, id: String, expires: Int64, verb: PageVerb }

public enum PageOutcome: String, Codable, Sendable { case ok, alreadyTrue, notAllowed, stale, failed, handoff, noElement, excluded, unsupported, error, siteOff }

public struct PageWriteReadings: Codable, Equatable, Sendable {
    public var before: String, afterInput: String, afterBlur: String, invalid: Bool, error: String?
}

/// What pageChooseOption found and checked (W2).
public struct PageChoice: Codable, Equatable, Sendable {
    public enum Flavor: String, Codable, Sendable { case aria, reactSelect }
    public enum HiddenInput: String, Codable, Sendable { case set, unchanged, none }
    public var flavor: Flavor, matches: [String], expanded: Bool?, hiddenInput: HiddenInput
}

/// What pageAttachFile checked (W2).
public struct PageAttached: Codable, Equatable, Sendable {
    public struct File: Codable, Equatable, Sendable { public var name: String, size: Int }
    public enum Via: String, Codable, Sendable { case input, drop }
    public var via: Via, file: File?, shown: Bool
}

public struct PageResult: Codable, Equatable, Sendable {
    public var v: Int, id: String, at: Int64, outcome: PageOutcome, detail: String?, readings: PageWriteReadings?, risk: String?
    public var choice: PageChoice?, attached: PageAttached?
}

/// Focus moved in the tab the user is in (W2); nothing about the element.
public struct PageFocusMoved: Codable, Equatable, Sendable { public var v: Int, at: Int64, tabId: Int, frameId: Int }

/// "Not on this site": every origin Caret is off for, the whole list each time (W2).
public struct PageSitesOff: Codable, Equatable, Sendable { public var v: Int, origins: [String] }

public struct PageHello: Codable, Equatable, Sendable {
    public var v: Int, extensionId: String, version: String, profile: String, instance: String, startedAt: Int64, capabilities: [String]
}

public struct PagePing: Codable, Equatable, Sendable { public var v: Int, id: String }
public struct PagePong: Codable, Equatable, Sendable { public var v: Int, id: String, at: Int64, instance: String, startedAt: Int64 }

public struct BrowserRef: Codable, Equatable, Sendable {
    public var pid: Int32, bundleId: String, name: String
    public init(pid: Int32, bundleId: String, name: String) { self.pid = pid; self.bundleId = bundleId; self.name = name }
}

public struct EngineChallenge: Codable, Equatable, Sendable { public var v: Int, nonce: String }

public struct EngineHello: Codable, Equatable, Sendable {
    public var type = "engineHello", v = 1, role = "page"
    public var browser: BrowserRef, extensionId: String, bridgeVersion: String, nonce: String, proof: String
    public init(browser: BrowserRef, extensionId: String, bridgeVersion: String, nonce: String, proof: String) {
        self.browser = browser; self.extensionId = extensionId; self.bridgeVersion = bridgeVersion; self.nonce = nonce; self.proof = proof
    }
}

public struct EngineWelcome: Codable, Equatable, Sendable { public var v: Int, engine: String, proof: String }

public struct EngineReady: Codable, Equatable, Sendable {
    public var type = "engineReady", v = 1
    public var engine: String
    public init(engine: String) { self.engine = engine }
}

public struct PageChunk: Codable, Equatable, Sendable {
    public var type = "pageChunk", v = 1
    public var id: String, index: Int, count: Int, data: String
    public init(id: String, index: Int, count: Int, data: String) { self.id = id; self.index = index; self.count = count; self.data = data }
}

/// Every message on page.sock or the Native Messaging port, by its `type`.
public enum PageMessage: Decodable, Equatable, Sendable {
    case engineChallenge(EngineChallenge), engineHello(EngineHello), engineWelcome(EngineWelcome), engineReady(EngineReady)
    case pageHello(PageHello), pageCommand(PageCommand), pageSnapshot(PageSnapshot), pageResult(PageResult)
    case scopedActGrant(ScopedActGrant), actRevoke(ActRevoke), pagePing(PagePing), pagePong(PagePong), pageChunk(PageChunk)
    case pageFocus(PageFocusMoved), pageSitesOff(PageSitesOff)

    private enum K: String, CodingKey { case type }
    public init(from d: Decoder) throws {
        let type = try d.container(keyedBy: K.self).decode(String.self, forKey: .type)
        switch type {
        case "engineChallenge": self = .engineChallenge(try EngineChallenge(from: d))
        case "engineHello": self = .engineHello(try EngineHello(from: d))
        case "engineWelcome": self = .engineWelcome(try EngineWelcome(from: d))
        case "engineReady": self = .engineReady(try EngineReady(from: d))
        case "pageHello": self = .pageHello(try PageHello(from: d))
        case "pageCommand": self = .pageCommand(try PageCommand(from: d))
        case "pageSnapshot": self = .pageSnapshot(try PageSnapshot(from: d))
        case "pageResult": self = .pageResult(try PageResult(from: d))
        case "scopedActGrant": self = .scopedActGrant(try ScopedActGrant(from: d))
        case "actRevoke": self = .actRevoke(try ActRevoke(from: d))
        case "pagePing": self = .pagePing(try PagePing(from: d))
        case "pagePong": self = .pagePong(try PagePong(from: d))
        case "pageChunk": self = .pageChunk(try PageChunk(from: d))
        case "pageFocus": self = .pageFocus(try PageFocusMoved(from: d))
        case "pageSitesOff": self = .pageSitesOff(try PageSitesOff(from: d))
        default: throw DecodingError.dataCorrupted(.init(codingPath: [K.type], debugDescription: "unknown page message \(type)"))
        }
    }
}

/// Which way a message may travel through the bridge once the handshake is done. Anything else is dropped.
public enum Direction: Sendable {
    /// Extension to helper: what EngineMessage allows.
    case toHelper
    /// Helper to extension: what HelperToEngine allows.
    case toExtension

    public var allowed: Set<String> {
        switch self {
        case .toHelper: ["pageHello", "pageSnapshot", "pageResult", "pagePong", "pageFocus"]
        case .toExtension: ["pageCommand", "scopedActGrant", "actRevoke", "pagePing", "pageSitesOff"]
        }
    }
}
