import Foundation

/// The window server number read from the captured field's AXWindow. A missing number means no screen context.
public struct ScreenTextTarget: Equatable, Sendable {
    public let pid: Int32
    public let windowNumber: UInt32
    public init(pid: Int32, windowNumber: UInt32) { self.pid = pid; self.windowNumber = windowNumber }
}

/// One window and reader revision, in memory only. Generation reads synchronously and never waits for the helper.
public struct ScreenTextCache: Sendable {
    public struct Key: Equatable, Sendable {
        public let target: ScreenTextTarget
        public let revision: UInt64
        public let appsOff: [String]
        public let sitesOff: [String]
        public let site: String?

        public init(target: ScreenTextTarget, revision: UInt64, appsOff: [String], sitesOff: [String], site: String?) {
            self.target = target; self.revision = revision; self.appsOff = appsOff; self.sitesOff = sitesOff; self.site = site
        }
    }

    private var key: Key?
    private var pendingID: String?
    private var cachedText: String?
    public init() {}

    /// Changing the target, reader revision or privacy policy drops old text before returning a request.
    public mutating func prefetch(_ key: Key, id: String) -> ScreenTextRequest? {
        guard key != self.key else { return nil }
        clear()
        guard key.target.pid > 0, key.target.windowNumber > 0 else { return nil }
        self.key = key
        pendingID = id
        return ScreenTextRequest(id: id, revision: key.revision, pid: key.target.pid, windowNumber: key.target.windowNumber,
                                 appsOff: key.appsOff, sitesOff: key.sitesOff, site: key.site)
    }

    public mutating func receive(_ reply: ScreenTextReply) {
        guard reply.id == pendingID, reply.revision == key?.revision else { return }
        pendingID = nil
        cachedText = reply.text
    }

    public func text(for key: Key) -> String? { self.key == key ? cachedText : nil }

    public mutating func clear() {
        key = nil
        pendingID = nil
        cachedText = nil
    }
}
