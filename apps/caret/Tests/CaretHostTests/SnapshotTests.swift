import AppKit
import CaretHostCore
import XCTest
@testable import CaretHost

/// Each pop-up spec and each line, rendered off screen in light and dark and compared with the
/// committed reference image made from the same synthetic content. A render that drifts fails.
///
/// `CARET_RECORD_SNAPSHOTS=1` rewrites the references; `CARET_SNAPSHOT_OUT=<dir>` also writes every
/// render (and the figure gallery) there, for review.
@MainActor
final class SnapshotTests: XCTestCase {
    static let references = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("References")

    /// A pixel differs when any channel moves by more than this (of 255), which absorbs
    /// antialiasing noise; a render drifts when more than `maxDifferingPixels` differ. Two renders
    /// of the same view on this Mac differ in 0 pixels; one changed 12 pt glyph at 2x changes
    /// well over 40. Untested across macOS versions, where font rendering may move more.
    static let channelTolerance = 24
    static let maxDifferingPixels = 40

    var record: Bool { ProcessInfo.processInfo.environment["CARET_RECORD_SNAPSHOTS"] == "1" }
    var outDir: URL? { ProcessInfo.processInfo.environment["CARET_SNAPSHOT_OUT"].map { URL(fileURLWithPath: $0) } }

    func testPopupSpecsMatchTheirReferences() throws {
        try check(Gallery.specs())
    }

    func testLinesMatchTheirReferences() throws {
        try check(Gallery.lines())
    }

    func testGallerySpecsMatchTheGoldenFixture() throws {
        // The renders and the decoder test the same pop-ups: the gallery's specs round-trip
        // through JSON to the golden file's content.
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../CaretHostCoreTests/Fixtures/popup-specs.json").standardized
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let valid = try XCTUnwrap(root["valid"] as? [String: Any])
        for (name, spec) in [("eventCard", Gallery.eventCard), ("fillPreview", Gallery.fillPreview), ("picker", Gallery.picker)] {
            let golden = try PopupSpec.decode(JSONSerialization.data(withJSONObject: valid[name]!))
            XCTAssertEqual(spec, golden, name)
        }
    }

    func testFigureGalleryRendersForEveryCharacterAndState() throws {
        for dark in [false, true] {
            let data = try XCTUnwrap(Gallery.png(FigureGalleryView(), dark: dark))
            XCTAssertGreaterThan(data.count, 1000)
            try outDir.map { try write(data, to: $0.appendingPathComponent("figure-states-\(dark ? "dark" : "light").png")) }
        }
        // The other characters' pop-ups and lines, for review only.
        guard let outDir else { return }
        for character in [FigureCharacter.seed, .wren] {
            for item in Gallery.specs(character).prefix(1) + Gallery.lines(character).prefix(3) {
                for dark in [false, true] {
                    let data = try XCTUnwrap(Gallery.png(item.view, dark: dark))
                    try write(data, to: outDir.appendingPathComponent("\(character.rawValue)/\(item.name)-\(dark ? "dark" : "light").png"))
                }
            }
        }
    }

    // MARK: -

    private func check(_ items: [Gallery.Item]) throws {
        for item in items {
            for dark in [false, true] {
                let name = "\(item.name)-\(dark ? "dark" : "light").png"
                let data = try XCTUnwrap(Gallery.png(item.view, dark: dark), name)
                try outDir.map { try write(data, to: $0.appendingPathComponent(name)) }
                let reference = Self.references.appendingPathComponent(name)
                if record {
                    try write(data, to: reference)
                    continue
                }
                guard let expected = try? Data(contentsOf: reference) else {
                    XCTFail("\(name): no reference; run with CARET_RECORD_SNAPSHOTS=1 and review the image")
                    continue
                }
                let drift = try Self.difference(data, expected)
                XCTAssertLessThanOrEqual(drift, Self.maxDifferingPixels, "\(name) drifted: \(drift) pixels differ")
            }
        }
    }

    private func write(_ data: Data, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url)
    }

    /// The number of pixels that differ; every pixel when the sizes differ.
    static func difference(_ a: Data, _ b: Data) throws -> Int {
        let (pa, wa, ha) = try rgba(a)
        let (pb, wb, hb) = try rgba(b)
        guard wa == wb, ha == hb else { return max(wa * ha, wb * hb) }
        var differing = 0
        for i in stride(from: 0, to: pa.count, by: 4) {
            for c in 0..<4 where abs(Int(pa[i + c]) - Int(pb[i + c])) > channelTolerance {
                differing += 1
                break
            }
        }
        return differing
    }

    private static func rgba(_ png: Data) throws -> ([UInt8], Int, Int) {
        let rep = try XCTUnwrap(NSBitmapImageRep(data: png))
        let w = rep.pixelsWide, h = rep.pixelsHigh
        var pixels = [UInt8](repeating: 0, count: w * h * 4)
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        let context = try XCTUnwrap(CGContext(
            data: &pixels, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: space,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.draw(try XCTUnwrap(rep.cgImage), in: CGRect(x: 0, y: 0, width: w, height: h))
        return (pixels, w, h)
    }

    func testTheDriftCheckCatchesAChangedRender() throws {
        let a = try XCTUnwrap(Gallery.png(PopupView(spec: Gallery.picker, highlight: 0, character: .pebble, animated: false), dark: false))
        let b = try XCTUnwrap(Gallery.png(PopupView(spec: Gallery.picker, highlight: 1, character: .pebble, animated: false), dark: false))
        XCTAssertEqual(try Self.difference(a, a), 0)
        XCTAssertGreaterThan(try Self.difference(a, b), Self.maxDifferingPixels, "moving the highlight must count as drift")
    }
}
