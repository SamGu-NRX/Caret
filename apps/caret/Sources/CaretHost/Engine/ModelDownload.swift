import CaretHostCore
import CryptoKit
import Foundation

/// Downloads Caret's model copy (brief item 8), only when the user asks for it.
///
/// The file goes to `.<name>.part` in the model folder first. A part left by an earlier try is continued with an HTTP
/// Range request, its bytes hashed again first; a server that answers the whole file instead starts the part over.
/// Each chunk is written and hashed as it arrives. Only when the size and the sha256 both match the published ones does
/// the part move into place, with the license written next to it. A wrong fingerprint deletes the part; a stop or a
/// network failure keeps it, so the next try continues. It refuses to start when free space would not cover what is
/// left plus `ModelFiles.diskMargin`.
final class ModelDownload: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    struct Spec: Equatable {
        var url: URL
        var fileName: String
        var sha256: String
        var bytes: Int64
        var licenseFileName: String
        var license: String

        static let gemma = Spec(url: ModelFiles.url, fileName: ModelFiles.fileName, sha256: ModelFiles.sha256, bytes: ModelFiles.bytes,
                                licenseFileName: ModelFiles.licenseFileName, license: ModelLicense.text)
    }

    enum Failure: Error, Equatable, CustomStringConvertible {
        case disk(String)
        case http(Int)
        case size(Int64)
        case fingerprint
        case network(String)
        case stopped
        case file(String)

        var description: String {
            switch self {
            case .disk(let why): return why
            case .http(let code): return "The download server answered \(code). Try again later."
            case .size(let n): return "The download ended at \(n) bytes, not the published size. Download again to continue."
            case .fingerprint: return "The downloaded file didn't match its published fingerprint, so Caret deleted it."
            case .network(let why): return "The download stopped: \(why). Download again to continue from there."
            case .stopped: return "Stopped. Download again to continue from there."
            case .file(let why): return "Caret couldn't write the model: \(why)"
            }
        }
    }

    let spec: Spec
    let folder: URL
    private let configuration: URLSessionConfiguration
    private let freeBytes: (URL) -> Int64?
    /// Bytes received so far and the total, on the session's queue.
    var onProgress: (Int64, Int64) -> Void = { _, _ in }

    // The task's state, touched only on `queue` once the task runs.
    private let queue: OperationQueue = {
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1
        return q
    }()
    private var session: URLSession?
    private var handle: FileHandle?
    private var hasher = SHA256()
    private var received: Int64 = 0
    private var failure: Failure?
    private var stopRequested = false
    private var continuation: CheckedContinuation<Void, Error>?

    init(spec: Spec = .gemma, folder: URL, configuration: URLSessionConfiguration = .default,
         freeBytes: @escaping (URL) -> Int64? = ModelDownload.volumeFreeBytes) {
        self.spec = spec
        self.folder = folder
        self.configuration = configuration
        self.freeBytes = freeBytes
    }

    var finalURL: URL { folder.appendingPathComponent(spec.fileName) }
    var partURL: URL { folder.appendingPathComponent(".\(spec.fileName).part") }
    var licenseURL: URL { folder.appendingPathComponent(spec.licenseFileName) }

    /// Downloads and verifies the file; returns where it now is. Throws `Failure`.
    func run() async throws -> URL {
        let fm = FileManager.default
        do { try fm.createDirectory(at: folder, withIntermediateDirectories: true) } catch { throw Failure.file(error.localizedDescription) }
        // A copy already in place that checks out needs nothing fetched.
        if let size = Self.size(of: finalURL), size == spec.bytes, (try? Self.digest(of: finalURL)) == spec.sha256 {
            try writeLicense()
            return finalURL
        }
        var have = Self.size(of: partURL) ?? 0
        if have > spec.bytes {
            try? fm.removeItem(at: partURL)
            have = 0
        }
        if let why = ModelFiles.diskRefusal(freeBytes: freeBytes(folder), alreadyHave: have, total: spec.bytes) { throw Failure.disk(why) }
        hasher = SHA256()
        if have > 0 {
            do { try Self.feed(&hasher, from: partURL) } catch { throw Failure.file(error.localizedDescription) }
        } else if !fm.fileExists(atPath: partURL.path) {
            fm.createFile(atPath: partURL.path, contents: nil)
        }
        do { handle = try FileHandle(forWritingTo: partURL); try handle?.seekToEnd() } catch { throw Failure.file(error.localizedDescription) }
        received = have
        failure = nil
        var request = URLRequest(url: spec.url)
        if have > 0 { request.setValue("bytes=\(have)-", forHTTPHeaderField: "Range") }
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
        self.session = session
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            queue.addOperation {
                self.continuation = c
                if self.stopRequested { return self.finish(.failure(Failure.stopped)) }
                session.dataTask(with: request).resume()
            }
        }
        return finalURL
    }

    /// Stops a running download, keeping what came in.
    func stop() {
        queue.addOperation {
            self.stopRequested = true
            self.session?.invalidateAndCancel()
        }
    }

    // MARK: - URLSessionDataDelegate (on `queue`)

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse else {
            failure = .network("no HTTP response")
            return completionHandler(.cancel)
        }
        switch http.statusCode {
        case 206:
            // The part continues only from exactly where it ends.
            guard Self.rangeStart(http.value(forHTTPHeaderField: "Content-Range")) == received else {
                failure = .network("the server sent a different part of the file")
                return completionHandler(.cancel)
            }
        case 200:
            // The whole file: start the part over.
            do {
                try handle?.truncate(atOffset: 0)
                hasher = SHA256()
                received = 0
            } catch {
                failure = .file(error.localizedDescription)
                return completionHandler(.cancel)
            }
        default:
            failure = .http(http.statusCode)
            return completionHandler(.cancel)
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard failure == nil else { return }
        do { try handle?.write(contentsOf: data) } catch {
            failure = .file(error.localizedDescription)
            return dataTask.cancel()
        }
        hasher.update(data: data)
        received += Int64(data.count)
        if received > spec.bytes {
            failure = .size(received)
            return dataTask.cancel()
        }
        onProgress(received, spec.bytes)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        try? handle?.close()
        handle = nil
        session.finishTasksAndInvalidate()
        if stopRequested { return finish(.failure(Failure.stopped)) }
        if let failure {
            // More bytes than the published size: the part is wrong, not unfinished.
            if case .size = failure { try? FileManager.default.removeItem(at: partURL) }
            return finish(.failure(failure))
        }
        if let error { return finish(.failure(Failure.network(error.localizedDescription))) }
        guard received == spec.bytes else { return finish(.failure(Failure.size(received))) }
        let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        guard digest == spec.sha256 else {
            try? FileManager.default.removeItem(at: partURL)
            return finish(.failure(Failure.fingerprint))
        }
        do {
            let fm = FileManager.default
            if fm.fileExists(atPath: finalURL.path) { try fm.removeItem(at: finalURL) }
            try fm.moveItem(at: partURL, to: finalURL)
            try writeLicense()
            finish(.success(()))
        } catch let f as Failure {
            finish(.failure(f))
        } catch {
            finish(.failure(Failure.file(error.localizedDescription)))
        }
    }

    private func finish(_ result: Result<Void, Error>) {
        let c = continuation
        continuation = nil
        c?.resume(with: result)
    }

    private func writeLicense() throws {
        do { try Data(spec.license.utf8).write(to: licenseURL, options: .atomic) } catch { throw Failure.file(error.localizedDescription) }
    }

    // MARK: - Files

    static func size(of url: URL) -> Int64? {
        (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value
    }

    static func digest(of url: URL) throws -> String {
        var h = SHA256()
        try feed(&h, from: url)
        return h.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// Hashes a file in 8 MiB reads, so a 3.4 GB part never sits in memory whole.
    static func feed(_ hasher: inout SHA256, from url: URL) throws {
        let h = try FileHandle(forReadingFrom: url)
        defer { try? h.close() }
        while let chunk = try h.read(upToCount: 8 * 1024 * 1024), !chunk.isEmpty { hasher.update(data: chunk) }
    }

    /// The first byte of `bytes START-END/TOTAL`.
    static func rangeStart(_ header: String?) -> Int64? {
        guard let header, header.hasPrefix("bytes "), let dash = header.firstIndex(of: "-") else { return nil }
        return Int64(header[header.index(header.startIndex, offsetBy: 6)..<dash])
    }

    static func volumeFreeBytes(_ url: URL) -> Int64? {
        let values = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        return values?.volumeAvailableCapacityForImportantUsage
    }
}
