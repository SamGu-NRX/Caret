import CaretHostCore
import XCTest
@testable import CaretHost

/// The host's search for a plan's likely file (H5): by name, in the folders it is given and one level
/// under them, newest first. Runs on a temporary folder, never the user's.
final class LikelyFilesTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("caret-h5-likely-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func put(_ path: String, daysAgo: Double, bytes: Int = 3) throws {
        let url = root.appendingPathComponent(path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(repeating: 0x25, count: bytes).write(to: url)
        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(-daysAgo * 86_400)], ofItemAtPath: url.path)
    }

    func testTheNewestMatchingDocumentWithinTwoLevelsIsProposed() throws {
        try put("Documents/Old_Resume.pdf", daysAgo: 300)
        try put("Downloads/Dana Resume 2026.pdf", daysAgo: 2)
        try put("Downloads/jobs/CV.docx", daysAgo: 5)
        try put("Desktop/resume-photo.png", daysAgo: 0)
        try put("Desktop/.resume.pdf", daysAgo: 0)
        try put("Downloads/a/b/c/resume.pdf", daysAgo: 0)
        let roots = ["Documents", "Downloads", "Desktop"].map { root.appendingPathComponent($0).path }
        let found = try XCTUnwrap(LikelyFiles.find(wants: "your resume", roots: roots))
        XCTAssertEqual(found.name, "Dana Resume 2026.pdf")
        XCTAssertEqual(found.size, 3)
        XCTAssertNil(LikelyFiles.find(wants: "your transcript", roots: roots))
        XCTAssertNil(LikelyFiles.find(wants: "the thing", roots: roots), "no words for it, no search")
        XCTAssertNil(LikelyFiles.find(wants: "your resume", roots: [root.appendingPathComponent("missing").path]))
    }
}
