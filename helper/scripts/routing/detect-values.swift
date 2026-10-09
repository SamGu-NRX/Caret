// The reader's typed-value detector (CaretScreenCore/TypedValues.swift) over texts read from stdin, for evaluations
// that build screens without the reader: a JSON array of strings in, a JSON array of [{kind, text}] out, one per text.
// scripts/routing/corpus-eval.ts compiles it with that one file, so the corpus sees the spans the reader would report.
import Foundation

@main
struct DetectValues {
    static func main() throws {
        let texts = try JSONDecoder().decode([String].self, from: FileHandle.standardInput.readDataToEndOfFile())
        let detector = TypedValueDetector()
        let out: [[[String: String]]] = texts.map { t in detector.detect(t).map { ["kind": $0.kind.rawValue, "text": $0.text] } }
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: out))
    }
}

// The protocol types TypedValues.swift reads, as Protocol.swift declares them; the rest of that file is not needed.
public enum ValueKind: String, Codable, Sendable, CaseIterable {
    case date, time, email, phone, url, address, amount, id
}

public enum NodeState: String, Codable, Hashable, Sendable {
    case focused, selected, disabled, expanded, checked, secure
}

public struct Node: Sendable {
    public var key: String
    public var label: String?
    public var value: String?
    public var editable: Bool
    public var states: [NodeState]
}

public struct TypedValue: Sendable {
    public var kind: ValueKind
    public var text: String
    public var nodeKey: String
    public init(kind: ValueKind, text: String, nodeKey: String) {
        self.kind = kind; self.text = text; self.nodeKey = nodeKey
    }
}
