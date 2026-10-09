import CryptoKit
import XCTest
@testable import CaretHost

/// Brief item 8: the model download against a fixture file and a stub server. Nothing leaves this process.
final class ModelDownloadTests: XCTestCase {
    /// A stub server for one URL: whole or ranged answers, sent in 64 KiB chunks.
    final class Stub: URLProtocol {
        struct Behavior {
            var body = Data()
            var honorsRange = true
            var status = 200
            /// Send this many bytes, then hang until cancelled.
            var hangAfter: Int?
        }
        nonisolated(unsafe) static var behavior = Behavior()
        nonisolated(unsafe) static var requests: [URLRequest] = []

        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

        override func startLoading() {
            Self.requests.append(request)
            let b = Self.behavior
            let url = request.url!
            if b.status != 200 {
                client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: b.status, httpVersion: "HTTP/1.1", headerFields: [:])!, cacheStoragePolicy: .notAllowed)
                client?.urlProtocolDidFinishLoading(self)
                return
            }
            var start = 0
            var status = 200
            var headers = ["Content-Length": "\(b.body.count)"]
            if b.honorsRange, let range = request.value(forHTTPHeaderField: "Range"), range.hasPrefix("bytes="),
               let n = Int(range.dropFirst(6).prefix { $0 != "-" }) {
                start = n
                status = 206
                headers = ["Content-Range": "bytes \(n)-\(b.body.count - 1)/\(b.body.count)", "Content-Length": "\(b.body.count - n)"]
            }
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!, cacheStoragePolicy: .notAllowed)
            var at = start
            let end = b.hangAfter.map { min(start + $0, b.body.count) } ?? b.body.count
            while at < end {
                let next = min(at + 65_536, end)
                client?.urlProtocol(self, didLoad: b.body.subdata(in: at..<next))
                at = next
            }
            if b.hangAfter == nil { client?.urlProtocolDidFinishLoading(self) }
        }

        override func stopLoading() {}
    }

    var folder: URL!
    let body = Data((0..<300_000).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ 7) })
    var sha: String { SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined() }

    override func setUp() {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("model-\(UUID().uuidString)", isDirectory: true)
        Stub.behavior = Stub.Behavior(body: body)
        Stub.requests = []
    }

    override func tearDown() { try? FileManager.default.removeItem(at: folder) }

    func download(sha256: String? = nil, free: Int64? = 1 << 40) -> ModelDownload {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [Stub.self]
        let spec = ModelDownload.Spec(url: URL(string: "https://models.example.test/m.gguf")!, fileName: "m.gguf", sha256: sha256 ?? sha,
                                      bytes: Int64(body.count), licenseFileName: "m.gguf.LICENSE.txt", license: ModelLicense.text)
        return ModelDownload(spec: spec, folder: folder, configuration: config, freeBytes: { _ in free })
    }

    func testAFreshDownloadIsVerifiedThenMovedIntoPlaceWithItsLicense() async throws {
        let d = download()
        let url = try await d.run()
        XCTAssertEqual(try Data(contentsOf: url), body)
        XCTAssertFalse(FileManager.default.fileExists(atPath: d.partURL.path))
        let license = try String(contentsOf: d.licenseURL, encoding: .utf8)
        XCTAssertTrue(license.contains("Apache License"))
        XCTAssertTrue(license.contains("END OF TERMS AND CONDITIONS"))
        XCTAssertNil(Stub.requests.first?.value(forHTTPHeaderField: "Range"))
    }

    func testAPartLeftByAnEarlierTryIsContinued() async throws {
        let d = download()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try body.prefix(100_000).write(to: d.partURL)
        let url = try await d.run()
        XCTAssertEqual(Stub.requests.first?.value(forHTTPHeaderField: "Range"), "bytes=100000-")
        XCTAssertEqual(try Data(contentsOf: url), body)
    }

    func testAServerThatSendsTheWholeFileStartsThePartOver() async throws {
        Stub.behavior.honorsRange = false
        let d = download()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try Data(repeating: 0xEE, count: 50_000).write(to: d.partURL)
        let url = try await d.run()
        XCTAssertEqual(try Data(contentsOf: url), body)
    }

    func testAWrongFingerprintDeletesThePartAndPutsNothingInPlace() async throws {
        let d = download(sha256: String(repeating: "0", count: 64))
        do {
            _ = try await d.run()
            XCTFail("a wrong fingerprint must not succeed")
        } catch let f as ModelDownload.Failure {
            XCTAssertEqual(f, .fingerprint)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: d.finalURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: d.partURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: d.licenseURL.path))
    }

    func testTooLittleFreeSpaceRefusesBeforeAnyRequest() async throws {
        let d = download(free: 1_000)
        do {
            _ = try await d.run()
            XCTFail("must refuse")
        } catch let f as ModelDownload.Failure {
            guard case .disk = f else { return XCTFail("\(f)") }
        }
        XCTAssertTrue(Stub.requests.isEmpty)
    }

    func testStoppingKeepsWhatCameInForTheNextTry() async throws {
        Stub.behavior.hangAfter = 131_072
        let d = download()
        let stopped = expectation(description: "progress")
        stopped.assertForOverFulfill = false
        d.onProgress = { received, _ in if received >= 131_072 { d.stop(); stopped.fulfill() } }
        do {
            _ = try await d.run()
            XCTFail("a stopped download must not succeed")
        } catch let f as ModelDownload.Failure {
            XCTAssertEqual(f, .stopped)
        }
        await fulfillment(of: [stopped], timeout: 5)
        XCTAssertEqual(ModelDownload.size(of: d.partURL), 131_072)
        XCTAssertFalse(FileManager.default.fileExists(atPath: d.finalURL.path))
        // The next try continues from there.
        Stub.behavior.hangAfter = nil
        Stub.requests = []
        let again = download()
        let url = try await again.run()
        XCTAssertEqual(Stub.requests.first?.value(forHTTPHeaderField: "Range"), "bytes=131072-")
        XCTAssertEqual(try Data(contentsOf: url), body)
    }

    func testAServerErrorKeepsThePart() async throws {
        Stub.behavior.status = 503
        let d = download()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try body.prefix(10).write(to: d.partURL)
        do {
            _ = try await d.run()
            XCTFail("must fail")
        } catch let f as ModelDownload.Failure {
            XCTAssertEqual(f, .http(503))
        }
        XCTAssertEqual(ModelDownload.size(of: d.partURL), 10)
    }

    func testACopyAlreadyInPlaceIsNotFetchedAgain() async throws {
        let d = download()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try body.write(to: d.finalURL)
        _ = try await d.run()
        XCTAssertTrue(Stub.requests.isEmpty)
        XCTAssertTrue(FileManager.default.fileExists(atPath: d.licenseURL.path))
    }

    func testContentRangeStart() {
        XCTAssertEqual(ModelDownload.rangeStart("bytes 100-299/300"), 100)
        XCTAssertNil(ModelDownload.rangeStart("items 1-2/3"))
        XCTAssertNil(ModelDownload.rangeStart(nil))
    }
}
