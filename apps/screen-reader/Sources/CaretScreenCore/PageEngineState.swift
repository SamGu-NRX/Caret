import Foundation

/// Helper to host (W2): whether Caret can see a Chromium browser's pages (helper/src/protocol.ts PageEngineState).
/// `missing`: the browser is frontmost, the user has typed in it, and no Caret page engine is connected for that
/// process; the host may show "Caret can't see this page yet" once per browser per session. `connected`: an engine for
/// that browser said hello. Sent once per change of state per browser process.
public struct PageEngineState: Codable, Equatable, Sendable {
    public static let type = "pageEngine"
    public enum State: String, Codable, Sendable { case missing, connected }
    public var at: Int64
    public var browser: AppRef
    public var state: State
    public init(at: Int64, browser: AppRef, state: State) {
        self.at = at; self.browser = browser; self.state = state
    }
    enum CodingKeys: String, CodingKey { case at, browser, state }
    public init(from decoder: Decoder) throws {
        try checkEnvelope(decoder, Self.type)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        at = try c.decode(Int64.self, forKey: .at); browser = try c.decode(AppRef.self, forKey: .browser)
        state = try c.decode(State.self, forKey: .state)
    }
    public func encode(to encoder: Encoder) throws {
        try writeEnvelope(encoder, Self.type)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(at, forKey: .at); try c.encode(browser, forKey: .browser); try c.encode(state, forKey: .state)
    }
}
