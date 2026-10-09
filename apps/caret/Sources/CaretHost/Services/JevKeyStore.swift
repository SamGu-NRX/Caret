import CaretHostCore
import Foundation
import Security

/// The Jev key, kept in the user's login keychain under Caret's own service name (H12, lead decision 3), so it survives
/// a restart without `launchctl setenv` or a file.
///
/// The item is a generic password, service `dev.caret.host.jev`, account `TYPESAFE_API_KEY`, in the file-based login
/// keychain (not the data protection keychain, which needs a keychain-access-groups entitlement Caret does not have).
/// The keychain's access list trusts the code that made the item, so the same signed Caret reads it back without a
/// prompt.
///
/// Every query names one keychain file, never the search list or the default keychain: a matching item in another
/// keychain the user has added is not Caret's, and the default keychain need not be the login one (H12 review). Only the
/// user's own Caret opens the login keychain (`login(userHome:)`); tests create a keychain file of their own and pass
/// it, so no test can reach the login keychain by leaving an argument out.
public struct JevKeyStore {
    public static let service = "dev.caret.host.jev"
    public static let account = "TYPESAFE_API_KEY"

    public let keychain: SecKeychain

    public init(keychain: SecKeychain) {
        self.keychain = keychain
    }

    /// The store in `<userHome>/Library/Keychains/login.keychain-db`, or nil when that file is not there. Opening a
    /// keychain reads nothing and asks nothing; it names the file the queries below are held to.
    public static func login(userHome: String) -> JevKeyStore? {
        let path = userHome + "/Library/Keychains/login.keychain-db"
        guard FileManager.default.fileExists(atPath: path) else { return nil }
        var keychain: SecKeychain?
        guard SecKeychainOpen(path, &keychain) == errSecSuccess, let keychain else { return nil }
        return JevKeyStore(keychain: keychain)
    }

    public struct Failure: Error, CustomStringConvertible, Equatable {
        public let status: OSStatus
        public let action: String
        public var description: String {
            let text = (SecCopyErrorMessageString(status, nil) as String?) ?? "OSStatus \(status)"
            return "could not \(action) the Jev key in the keychain: \(text)"
        }
    }

    private func query(_ extra: [CFString: Any] = [:]) -> [CFString: Any] {
        var q: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: Self.service, kSecAttrAccount: Self.account,
                                  kSecMatchSearchList: [keychain]]
        for (k, v) in extra { q[k] = v }
        return q
    }

    /// Whether an item is there, from its attributes alone: reading attributes never asks the user anything.
    public func exists() -> Bool {
        SecItemCopyMatching(query([kSecReturnAttributes: true, kSecMatchLimit: kSecMatchLimitOne]) as CFDictionary, nil) == errSecSuccess
    }

    /// The key, or nil when there is none or the keychain will not give it (locked, or the user said no).
    public func read() -> String? {
        var out: CFTypeRef?
        guard SecItemCopyMatching(query([kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne]) as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data, let key = String(data: data, encoding: .utf8), !key.isEmpty else { return nil }
        return key
    }

    /// Saves `key`, replacing a key already there.
    public func save(_ key: String) throws {
        let data = Data(key.utf8)
        let update = SecItemUpdate(query() as CFDictionary, [kSecValueData: data] as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw Failure(status: update, action: "replace") }
        var add: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword, kSecAttrService: Self.service, kSecAttrAccount: Self.account,
            kSecAttrLabel: "Caret: Jev API key", kSecValueData: data, kSecUseKeychain: keychain,
        ]
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw Failure(status: status, action: "save") }
    }

    /// Removes the key; removing a key that is not there is not an error.
    public func delete() throws {
        let status = SecItemDelete(query() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure(status: status, action: "remove") }
    }
}

/// Sends `JevKeyCheck.request` and reports the HTTP status, or nil when no response came. A seam so a test can answer
/// with any status without the network.
public protocol JevKeyTransport: Sendable {
    func status(for request: URLRequest) async -> Int?
}

/// The check over the network: an ephemeral session, so no cookie, cache entry or credential outlives the request.
/// Redirects are refused, so the status is Jev's own answer to the one request: a 302 to a page that answers 200 would
/// otherwise read as a key that works (H12 review).
/// Unchecked: the configuration is only read, and URLSession copies it when the session is made.
public struct URLSessionJevKeyTransport: JevKeyTransport, @unchecked Sendable {
    /// Ephemeral; a test adds its own URLProtocol to it.
    let configuration: URLSessionConfiguration

    public init(configuration: URLSessionConfiguration = .ephemeral) {
        self.configuration = configuration
    }

    public func status(for request: URLRequest) async -> Int? {
        let session = URLSession(configuration: configuration)
        defer { session.finishTasksAndInvalidate() }
        guard let (_, response) = try? await session.data(for: request, delegate: NoRedirects()) else { return nil }
        return (response as? HTTPURLResponse)?.statusCode
    }

    final class NoRedirects: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest) async -> URLRequest? { nil }
    }
}

extension JevKeyCheck {
    /// Checks `key` with one request through `transport`. Nothing is logged: the key is in the request's header only.
    public static func check(_ key: String, transport: JevKeyTransport) async -> Outcome {
        outcome(status: await transport.status(for: request(key: key)))
    }
}
