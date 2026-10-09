import Foundation
import LocalModelCore
import Testing

private func d(_ s: String) -> Data { Data(s.utf8) }
private func lines(_ fs: [Frame]) -> [String] {
    fs.map {
        switch $0 {
        case .line(let x): return String(decoding: x, as: UTF8.self)
        case .tooLong(let n): return "<tooLong \(n)>"
        }
    }
}

struct LineFramerTests {
    @Test func splitsTwoRequestsInOneChunk() {
        var f = LineFramer(maxBytes: 100)
        #expect(lines(f.push(d("{\"a\":1}\n{\"b\":2}\n"))) == ["{\"a\":1}", "{\"b\":2}"])
        #expect(f.finish().isEmpty)
    }

    @Test func joinsALineSplitAcrossChunksEvenInsideACharacter() {
        var f = LineFramer(maxBytes: 100)
        let bytes = Array("{\"t\":\"café\"}\n".utf8)
        // Split inside the two bytes of "é".
        let cut = bytes.firstIndex(of: 0xC3)! + 1
        #expect(f.push(Data(bytes[..<cut])).isEmpty)
        #expect(lines(f.push(Data(bytes[cut...]))) == ["{\"t\":\"café\"}"])
    }

    @Test func reportsAnOverLongLineOnceAndResumesAtTheNext() {
        var f = LineFramer(maxBytes: 8)
        var out = f.push(d("0123456789"))
        out += f.push(d("abc\nok\n"))
        #expect(lines(out) == ["<tooLong 13>", "ok"])
    }

    @Test func reportsAnOverLongLineEndingInTheSameChunk() {
        var f = LineFramer(maxBytes: 4)
        #expect(lines(f.push(d("123456\nab\n"))) == ["<tooLong 6>", "ab"])
    }

    @Test func aLineExactlyAtTheLimitPasses() {
        var f = LineFramer(maxBytes: 4)
        #expect(lines(f.push(d("1234\n"))) == ["1234"])
    }

    @Test func deliversALastLineWithoutANewlineAtEnd() {
        var f = LineFramer(maxBytes: 100)
        #expect(f.push(d("{\"x\":1}")).isEmpty)
        #expect(lines(f.finish()) == ["{\"x\":1}"])
    }

    @Test func skipsBlankLines() {
        var f = LineFramer(maxBytes: 100)
        #expect(lines(f.push(d("\n  \r\n{}\n"))) == ["{}"])
    }
}

struct RequestTests {
    private func parse(_ s: String) -> Result<Request, RequestError> { parseRequest(d(s)) }

    @Test func parsesAFullRequest() throws {
        let r = try parse(#"{"id":"a1","prefix":"P","prompt":"Q","grammar":"root ::= \"x\"","maxTokens":40}"#).get()
        #expect(r == Request(id: "a1", prefix: "P", prompt: "Q", grammar: #"root ::= "x""#, maxTokens: 40))
    }

    @Test func prefixIsOptional() throws {
        let r = try parse(#"{"id":"a1","prompt":"Q","grammar":"g","maxTokens":1}"#).get()
        #expect(r.prefix == "")
    }

    @Test(arguments: [
        (#"{"id":"a1","prompt":"Q","maxTokens":4}"#, "'grammar' must be a non-empty string"),
        (#"{"id":"a1","prompt":"Q","grammar":"","maxTokens":4}"#, "'grammar' must be a non-empty string"),
        (#"{"id":"a1","prompt":"","grammar":"g","maxTokens":4}"#, "'prompt' must be a non-empty string"),
        (#"{"id":"a1","prompt":"Q","grammar":"g","maxTokens":0}"#, "'maxTokens' must be an integer from 1 to 2048"),
        (#"{"id":"a1","prompt":"Q","grammar":"g","maxTokens":2.5}"#, "'maxTokens' must be an integer from 1 to 2048"),
        (#"{"id":"a1","prompt":"Q","grammar":"g","maxTokens":true}"#, "'maxTokens' must be an integer from 1 to 2048"),
        (#"{"id":"a1","prompt":"Q","grammar":"g","maxTokens":1e20}"#, "'maxTokens' must be an integer from 1 to 2048"),
        (#"{"id":"a1","prompt":"Q","grammar":"g","maxTokens":4,"temperature":0}"#, "unknown key 'temperature'"),
        (#"{"id":"a1","prefix":3,"prompt":"Q","grammar":"g","maxTokens":4}"#, "'prefix' must be a string"),
    ])
    func refusesABadRequestNamingWhatIsWrong(line: String, message: String) {
        #expect(parse(line) == .failure(RequestError(id: "a1", description: message)))
    }

    @Test func aBadLineWithoutAnIdHasANullId() {
        #expect(parse("not json") == .failure(RequestError(id: nil, description: "the line is not a JSON object")))
        #expect(parse("[1]") == .failure(RequestError(id: nil, description: "the line is not a JSON object")))
        #expect(parse(#"{"prompt":"Q","grammar":"g","maxTokens":4}"#) == .failure(RequestError(id: nil, description: "'id' must be a non-empty string")))
    }
}

struct ResponseTests {
    @Test func aCompletionIsOneLineEvenWhenItsTextHasNewlinesAndQuotes() throws {
        let c = Completion(id: "a1", text: "route: fill\nliteral: \"x\" = y\n", stop: .eog, prefixTokens: 10, prefixCached: true, promptTokens: 5, outputTokens: 7, ms: Timing(prefix: 1, prompt: 2, decode: 3, total: 6), memory: MemoryUse(residentMB: 1, footprintMB: 2, peakFootprintMB: 3, peakResidentMB: 4))
        let line = encodeLine(c)
        #expect(line.last == 0x0A)
        #expect(line.dropLast().firstIndex(of: 0x0A) == nil)
        let o = try #require(try JSONSerialization.jsonObject(with: line) as? [String: Any])
        #expect(o["text"] as? String == "route: fill\nliteral: \"x\" = y\n")
        #expect(o["ok"] as? Bool == true)
        #expect(o["stop"] as? String == "eog")
        #expect((o["ms"] as? [String: Any])?["total"] as? Double == 6)
    }

    @Test func aFailureCarriesANullIdWhenItHasNone() throws {
        let o = try #require(try JSONSerialization.jsonObject(with: encodeLine(Failure(id: nil, error: "bad"))) as? [String: Any])
        #expect(o["id"] is NSNull)
        #expect(o["ok"] as? Bool == false)
        #expect(o["error"] as? String == "bad")
    }

    @Test func memoryReadingsAreThisProcesssOwn() {
        let m = MemoryUse.now()
        #expect(m.residentMB > 0)
        #expect(m.footprintMB > 0)
        #expect(m.peakFootprintMB >= m.footprintMB)
        #expect(m.peakResidentMB > 0)
    }
}
