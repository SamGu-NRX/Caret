import Foundation

/// A pop-up described as data: a list of blocks from a fixed catalog of eight (Fable plan,
/// section 2). The helper builds specs and validates them (helper/src/popup.ts); the host decodes
/// them here and renders them with its own layout, type and color. A spec carries no styling.
///
/// This is the screen track's copy of the host's decoder (CaretHostCore/PopupSpec.swift on v2/host
/// at 4048deb), with the same names, rules, checking order and errors, so the host may delete its
/// own and use this one. helper/src/popup.ts is a line-for-line port of the same decoder, and both
/// sides' tests run helper/fixtures/golden/popup-specs.json, the host's golden file.
///
/// Two rules are enforced on decode, each with its own error:
/// - Only the eight known block types exist. Anything else is `unknownBlock`.
/// - Every value shown to the user (`Value`) carries a `ref` naming where it came from: a
///   screen-model node, a memory entry, or a code derivation of other refs. A value without one is
///   `missingReference`, so a pop-up cannot show a fact that is not on screen or in memory.
///
/// Words that code writes (row labels such as "When", step names, action labels) are plain
/// strings. Action labels and keys come from code, never from a model.
public struct PopupSpec: Codable, Equatable, Sendable {
    public static let version = 1

    public var id: String
    /// The figure's state in the header: `offering`, or `needsYou` when nothing happens until the
    /// user answers (the "which of these three?" picker).
    public var figure: Figure
    public var blocks: [Block]

    public enum Figure: String, Codable, Sendable {
        case offering
        case needsYou
    }

    public init(id: String, figure: Figure, blocks: [Block]) {
        self.id = id
        self.figure = figure
        self.blocks = blocks
    }

    public var header: Header? {
        for block in blocks { if case .header(let h) = block.content { return h } }
        return nil
    }

    public var actions: [Action] {
        for block in blocks { if case .actions(let a) = block.content { return a.items } }
        return []
    }

    /// The choices block currently shown, if any: Command-1 to 3 and the arrows act on its rows.
    public var choices: Choices? {
        for block in blocks { if case .choices(let c) = block.content { return c } }
        return nil
    }

    // MARK: - Codable

    public init(from decoder: Decoder) throws {
        let json = try JSON(from: decoder)
        self = try Self.parse(json)
    }

    public func encode(to encoder: Encoder) throws {
        try json.encode(to: encoder)
    }

    /// Decodes and validates one spec. Throws `PopupSpecError`, never a generic decoding error.
    public static func decode(_ data: Data) throws -> PopupSpec {
        let json: JSON
        do {
            json = try JSONDecoder().decode(JSON.self, from: data)
        } catch {
            throw PopupSpecError.malformedJSON
        }
        return try parse(json)
    }
}

extension PopupSpec {
    // MARK: - Values and references

    /// Where a value came from.
    public indirect enum Ref: Equatable, Sendable {
        /// A screen-model node: the reader's `<windowId>/<elementKey>`. `quote` is the exact text on
        /// screen the value was taken from, so the host can recheck it before drawing.
        case node(key: String, quote: String?)
        /// A memory entry by id.
        case memory(id: String)
        /// Computed by code from other references, such as a time parsed from a sentence or a count of
        /// fields. `rule` names the code that did it.
        case derived(rule: String, from: [Ref])
    }

    /// Text shown to the user that came from the screen or memory.
    public struct Value: Equatable, Sendable {
        public var text: String
        public var ref: Ref

        public init(_ text: String, ref: Ref) {
            self.text = text
            self.ref = ref
        }
    }

    // MARK: - The catalog

    public struct Block: Equatable, Sendable {
        /// Optional, so an action can replace this block (`Action.Reveal.replace`).
        public var id: String?
        public var content: Content

        public init(id: String? = nil, _ content: Content) {
            self.id = id
            self.content = content
        }

        public enum Content: Equatable, Sendable {
            case header(Header)
            case facts(Facts)
            case fields(Fields)
            case choices(Choices)
            case diff(Diff)
            case steps(Steps)
            case source(Source)
            case actions(Actions)
        }

        /// The eight block types, in the order the plan lists them.
        public static let catalog = ["header", "facts", "fields", "choices", "diff", "steps", "source", "actions"]
    }

    /// The figure and a title.
    public struct Header: Equatable, Sendable {
        public var title: Value
        public init(title: Value) { self.title = title }
    }

    /// Label and value rows. A row without a label shows its value alone.
    public struct Facts: Equatable, Sendable {
        public struct Row: Equatable, Sendable {
            public var label: String?
            public var value: Value
            /// Secondary rows are set in the Secondary color (a calendar name, a conflict note).
            public var secondary: Bool
            public init(label: String? = nil, value: Value, secondary: Bool = false) {
                self.label = label
                self.value = value
                self.secondary = secondary
            }
        }
        public var rows: [Row]
        public init(rows: [Row]) { self.rows = rows }
    }

    /// Destination, value and state, one row per field.
    public struct Fields: Equatable, Sendable {
        /// `yours` (H5): a control Caret never writes or presses, with the value the user sets.
        public enum State: String, Codable, Sendable { case ready, kept, unsure, done, failed, yours }
        public struct Row: Equatable, Sendable {
            /// The destination field's label as it appears on screen.
            public var destination: Value
            /// What would be written. Nil for a kept field, which shows its existing value instead.
            public var value: Value?
            public var state: State
            public init(destination: Value, value: Value?, state: State) {
                self.destination = destination
                self.value = value
                self.state = state
            }
        }
        public var rows: [Row]
        /// Rows not listed: "and 1 more".
        public var more: Int
        public init(rows: [Row], more: Int = 0) {
            self.rows = rows
            self.more = more
        }
    }

    /// Up to three rows, chosen with the arrows or Command-1 to 3.
    public struct Choices: Equatable, Sendable {
        public struct Row: Equatable, Sendable {
            public var label: Value
            public var hint: Value?
            public init(label: Value, hint: Value? = nil) {
                self.label = label
                self.hint = hint
            }
        }
        public static let maxRows = 3
        public var rows: [Row]
        /// The highlighted row when the block first appears, zero-based.
        public var selected: Int
        public init(rows: [Row], selected: Int = 0) {
            self.rows = rows
            self.selected = selected
        }
    }

    /// Before and after for one value.
    public struct Diff: Equatable, Sendable {
        public var label: String?
        public var before: Value
        public var after: Value
        public init(label: String? = nil, before: Value, after: Value) {
            self.label = label
            self.before = before
            self.after = after
        }
    }

    /// Progress through a running plan.
    public struct Steps: Equatable, Sendable {
        public enum State: String, Codable, Sendable { case pending, running, done, failed }
        public struct Row: Equatable, Sendable {
            public var label: String
            public var state: State
            public init(label: String, state: State) {
                self.label = label
                self.state = state
            }
        }
        public var rows: [Row]
        public init(rows: [Row]) { self.rows = rows }
    }

    /// One line naming where the values came from, drawn as "from <value>".
    public struct Source: Equatable, Sendable {
        public var value: Value
        public init(_ value: Value) { self.value = value }
    }

    /// The key hints. Labels and keys are written by code from the plan's end state.
    public struct Actions: Equatable, Sendable {
        public var items: [Action]
        public init(items: [Action]) { self.items = items }
    }

    public struct Action: Equatable, Sendable {
        public enum Key: String, Codable, Sendable, CaseIterable {
            case tab
            case cmd1 = "cmd-1"
            case cmd2 = "cmd-2"
            case cmd3 = "cmd-3"
            case down

            /// 1, 2 or 3 for the Command-digit keys.
            public var digit: Int? {
                switch self {
                case .cmd1: return 1
                case .cmd2: return 2
                case .cmd3: return 3
                case .tab, .down: return nil
                }
            }
        }

        /// An action that changes the pop-up instead of finishing it: "⌘2 Change time" swaps the time
        /// row for three choices.
        public struct Reveal: Equatable, Sendable {
            /// The `id` of the block to replace.
            public var replace: String
            public var with: Block
            public init(replace: String, with: Block) {
                self.replace = replace
                self.with = with
            }
        }

        public var id: String
        public var label: String
        public var key: Key
        public var reveal: Reveal?

        public init(id: String, label: String, key: Key, reveal: Reveal? = nil) {
            self.id = id
            self.label = label
            self.key = key
            self.reveal = reveal
        }
    }
}

// MARK: - Navigation

// From the host's SurfaceOffers.swift, so both sides compute what a reveal leads to the same way.
extension PopupSpec {
    /// The spec after `actionID`'s reveal: its target block replaced and the revealing action gone
    /// from the bar. Unchanged when the action reveals nothing.
    public func applyingReveal(of actionID: String) -> PopupSpec {
        guard let action = actions.first(where: { $0.id == actionID }), let reveal = action.reveal else { return self }
        var copy = self
        copy.blocks = blocks.compactMap { block in
            if block.id == reveal.replace { return reveal.with }
            if case .actions(var bar) = block.content {
                bar.items.removeAll { $0.id == actionID }
                return Block(id: block.id, .actions(bar))
            }
            return block
        }
        return copy
    }

    /// Choice rows shown, which the arrows and Command-1 to 3 move between.
    public var rowCount: Int { choices?.rows.count ?? 0 }

    /// Command-digits bound to an action in the bar.
    public var numberedDigits: Set<Int> { Set(actions.compactMap(\.key.digit)) }

    public var hasDownAction: Bool { actions.contains { $0.key == .down } }
}

// MARK: - Errors

/// Why a spec was refused. `path` is a JSON path such as `blocks[2].rows[0].value`.
public enum PopupSpecError: Error, Equatable, Sendable, CustomStringConvertible {
    case malformedJSON
    case unsupportedVersion(Int)
    case wrongType(path: String, expected: String)
    case missingField(path: String)
    case unknownBlock(type: String, path: String)
    case missingReference(path: String)
    case invalidReference(path: String, reason: String)
    case empty(path: String)
    case tooManyChoices(path: String, count: Int)
    case selectionOutOfRange(path: String)
    case missingBlock(String)
    case duplicateBlock(type: String, path: String)
    case duplicateBlockID(String)
    case noPrimaryAction(path: String)
    case duplicateActionKey(path: String, key: String)
    case duplicateActionID(path: String, id: String)
    /// A Command-digit action next to a choices block, where Command-1 to 3 already choose rows.
    case actionKeyConflictsWithChoices(path: String, key: String)
    case unknownRevealTarget(path: String, id: String)
    /// The pop-up after the reveal breaks a rule of its own.
    case invalidReveal(path: String, reason: String)

    public var description: String {
        switch self {
        case .malformedJSON: return "not JSON"
        case .unsupportedVersion(let v): return "unsupported spec version \(v)"
        case .wrongType(let path, let expected): return "\(path): expected \(expected)"
        case .missingField(let path): return "\(path): missing"
        case .unknownBlock(let type, let path): return "\(path): unknown block type \"\(type)\" (catalog: \(PopupSpec.Block.catalog.joined(separator: ", ")))"
        case .missingReference(let path): return "\(path): value has no ref"
        case .invalidReference(let path, let reason): return "\(path): invalid ref: \(reason)"
        case .empty(let path): return "\(path): empty"
        case .tooManyChoices(let path, let count): return "\(path): \(count) choices, at most \(PopupSpec.Choices.maxRows)"
        case .selectionOutOfRange(let path): return "\(path): selected row does not exist"
        case .missingBlock(let type): return "spec has no \(type) block"
        case .duplicateBlock(let type, let path): return "\(path): second \(type) block"
        case .duplicateBlockID(let id): return "two blocks with id \"\(id)\""
        case .noPrimaryAction(let path): return "\(path): no tab action"
        case .duplicateActionKey(let path, let key): return "\(path): key \(key) used twice"
        case .duplicateActionID(let path, let id): return "\(path): action id \"\(id)\" used twice"
        case .actionKeyConflictsWithChoices(let path, let key): return "\(path): \(key) is taken by the choices block"
        case .unknownRevealTarget(let path, let id): return "\(path): reveal replaces unknown block \"\(id)\""
        case .invalidReveal(let path, let reason): return "\(path): after the reveal, \(reason)"
        }
    }

    /// The error as the golden fixture names it, `case(arg, arg)`, the same text popup.ts gives as
    /// `short`. Cases the fixture never names fall back to `description`.
    public var short: String {
        switch self {
        case .unknownBlock(let type, let path): return "unknownBlock(\(type), \(path))"
        case .missingReference(let path): return "missingReference(\(path))"
        case .invalidReference(let path, _): return "invalidReference(\(path))"
        case .tooManyChoices(let path, _): return "tooManyChoices(\(path))"
        case .noPrimaryAction(let path): return "noPrimaryAction(\(path))"
        case .actionKeyConflictsWithChoices(let path, _): return "actionKeyConflictsWithChoices(\(path))"
        case .unknownRevealTarget(let path, _): return "unknownRevealTarget(\(path))"
        case .invalidReveal(let path, _): return "invalidReveal(\(path))"
        case .duplicateBlock(let type, let path): return "duplicateBlock(\(type), \(path))"
        case .missingBlock(let type): return "missingBlock(\(type))"
        case .unsupportedVersion(let v): return "unsupportedVersion(\(v))"
        default: return description
        }
    }
}

// MARK: - Parsing

extension PopupSpec {
    public static func parse(_ json: JSON) throws -> PopupSpec {
        let root = try json.object("$")
        let version = try root.int("v", at: "$")
        guard version == Self.version else { throw PopupSpecError.unsupportedVersion(version) }
        let id = try root.string("id", at: "$")
        let figureName = try root.string("figure", at: "$")
        guard let figure = Figure(rawValue: figureName) else {
            throw PopupSpecError.wrongType(path: "$.figure", expected: "offering or needsYou")
        }
        let rawBlocks = try root.array("blocks", at: "$")
        guard !rawBlocks.isEmpty else { throw PopupSpecError.empty(path: "$.blocks") }
        var blocks: [Block] = []
        for (index, raw) in rawBlocks.enumerated() {
            blocks.append(try parseBlock(raw, path: "blocks[\(index)]"))
        }
        let spec = PopupSpec(id: id, figure: figure, blocks: blocks)
        try spec.checkStructure()
        return spec
    }

    /// Rules across blocks: one header first, one actions block with one Tab action, unique ids
    /// and keys, and Command-digit keys left to a choices block when one is shown.
    public func checkStructure() throws {
        var seen: [String: String] = [:]
        var ids = Set<String>()
        for (index, block) in blocks.enumerated() {
            let type = block.content.typeName
            let path = "blocks[\(index)]"
            // One choices block: the arrows and Command-digits act on a single set of rows.
            if type == "header" || type == "actions" || type == "source" || type == "choices" {
                if seen[type] != nil { throw PopupSpecError.duplicateBlock(type: type, path: path) }
            }
            seen[type] = path
            if let id = block.id {
                guard ids.insert(id).inserted else { throw PopupSpecError.duplicateBlockID(id) }
            }
        }
        guard seen["header"] != nil else { throw PopupSpecError.missingBlock("header") }
        guard let actionsPath = seen["actions"] else { throw PopupSpecError.missingBlock("actions") }

        let items = actions
        guard items.contains(where: { $0.key == .tab }) else {
            throw PopupSpecError.noPrimaryAction(path: actionsPath)
        }
        var keys = Set<Action.Key>()
        var actionIDs = Set<String>()
        for (index, action) in items.enumerated() {
            let path = "\(actionsPath).items[\(index)]"
            guard keys.insert(action.key).inserted else {
                throw PopupSpecError.duplicateActionKey(path: path, key: action.key.rawValue)
            }
            guard actionIDs.insert(action.id).inserted else {
                throw PopupSpecError.duplicateActionID(path: path, id: action.id)
            }
            if choices != nil, action.key.digit != nil {
                throw PopupSpecError.actionKeyConflictsWithChoices(path: path, key: action.key.rawValue)
            }
            if let reveal = action.reveal {
                guard ids.contains(reveal.replace) else {
                    throw PopupSpecError.unknownRevealTarget(path: "\(path).reveal", id: reveal.replace)
                }
                // What the reveal leads to must itself be a valid pop-up (a Tab action left, no
                // Command-digit next to the new rows).
                do {
                    try applyingReveal(of: action.id).checkStructure()
                } catch let error as PopupSpecError {
                    throw PopupSpecError.invalidReveal(path: "\(path).reveal", reason: error.description)
                }
            }
        }
    }

    public static func parseBlock(_ json: JSON, path: String) throws -> Block {
        let object = try json.object(path)
        let type = try object.string("type", at: path)
        let id = try object.optionalString("id", at: path)
        let content: Block.Content
        switch type {
        case "header":
            content = .header(Header(title: try object.value("title", at: path)))
        case "facts":
            let rows = try object.nonEmptyArray("rows", at: path).enumerated().map { index, raw in
                let rowPath = "\(path).rows[\(index)]"
                let row = try raw.object(rowPath)
                return Facts.Row(
                    label: try row.optionalString("label", at: rowPath),
                    value: try row.value("value", at: rowPath),
                    secondary: try row.optionalBool("secondary", at: rowPath) ?? false
                )
            }
            content = .facts(Facts(rows: rows))
        case "fields":
            let rows = try object.nonEmptyArray("rows", at: path).enumerated().map { index, raw in
                let rowPath = "\(path).rows[\(index)]"
                let row = try raw.object(rowPath)
                let stateName = try row.string("state", at: rowPath)
                guard let state = Fields.State(rawValue: stateName) else {
                    throw PopupSpecError.wrongType(path: "\(rowPath).state", expected: "ready, kept, unsure, done, failed or yours")
                }
                return Fields.Row(
                    destination: try row.value("destination", at: rowPath),
                    value: try row.optionalValue("value", at: rowPath),
                    state: state
                )
            }
            content = .fields(Fields(rows: rows, more: try object.optionalInt("more", at: path) ?? 0))
        case "choices":
            let raw = try object.nonEmptyArray("rows", at: path)
            guard raw.count <= Choices.maxRows else {
                throw PopupSpecError.tooManyChoices(path: "\(path).rows", count: raw.count)
            }
            let rows = try raw.enumerated().map { index, raw in
                let rowPath = "\(path).rows[\(index)]"
                let row = try raw.object(rowPath)
                return Choices.Row(label: try row.value("label", at: rowPath), hint: try row.optionalValue("hint", at: rowPath))
            }
            let selected = try object.optionalInt("selected", at: path) ?? 0
            guard rows.indices.contains(selected) else { throw PopupSpecError.selectionOutOfRange(path: "\(path).selected") }
            content = .choices(Choices(rows: rows, selected: selected))
        case "diff":
            content = .diff(Diff(
                label: try object.optionalString("label", at: path),
                before: try object.value("before", at: path),
                after: try object.value("after", at: path)
            ))
        case "steps":
            let rows = try object.nonEmptyArray("rows", at: path).enumerated().map { index, raw in
                let rowPath = "\(path).rows[\(index)]"
                let row = try raw.object(rowPath)
                let stateName = try row.string("state", at: rowPath)
                guard let state = Steps.State(rawValue: stateName) else {
                    throw PopupSpecError.wrongType(path: "\(rowPath).state", expected: "pending, running, done or failed")
                }
                return Steps.Row(label: try row.string("label", at: rowPath), state: state)
            }
            content = .steps(Steps(rows: rows))
        case "source":
            content = .source(Source(try object.value("value", at: path)))
        case "actions":
            let items = try object.nonEmptyArray("items", at: path).enumerated().map { index, raw in
                try parseAction(raw, path: "\(path).items[\(index)]")
            }
            content = .actions(Actions(items: items))
        default:
            throw PopupSpecError.unknownBlock(type: type, path: path)
        }
        return Block(id: id, content)
    }

    /// The bar of an action line, held to the rules of a pop-up's actions block: non-empty, a Tab
    /// action, and no key or id used twice. Items are named `path[i]`. popup.ts's checkActionBar
    /// checks the same things in the same order.
    public static func parseActionBar(_ json: JSON, path: String) throws -> [Action] {
        guard case .array(let raw) = json else { throw PopupSpecError.wrongType(path: path, expected: "array") }
        guard !raw.isEmpty else { throw PopupSpecError.empty(path: path) }
        let items = try raw.enumerated().map { index, item in try parseAction(item, path: "\(path)[\(index)]") }
        guard items.contains(where: { $0.key == .tab }) else { throw PopupSpecError.noPrimaryAction(path: path) }
        var keys = Set<Action.Key>()
        var ids = Set<String>()
        for (index, action) in items.enumerated() {
            guard keys.insert(action.key).inserted else {
                throw PopupSpecError.duplicateActionKey(path: "\(path)[\(index)]", key: action.key.rawValue)
            }
            guard ids.insert(action.id).inserted else {
                throw PopupSpecError.duplicateActionID(path: "\(path)[\(index)]", id: action.id)
            }
        }
        return items
    }

    private static func parseAction(_ json: JSON, path: String) throws -> Action {
        let object = try json.object(path)
        let keyName = try object.string("key", at: path)
        guard let key = Action.Key(rawValue: keyName) else {
            throw PopupSpecError.wrongType(path: "\(path).key", expected: "tab, cmd-1, cmd-2, cmd-3 or down")
        }
        var reveal: Action.Reveal?
        if let raw = object["reveal"], raw != .null {
            let revealPath = "\(path).reveal"
            let r = try raw.object(revealPath)
            guard let with = r["with"] else { throw PopupSpecError.missingField(path: "\(revealPath).with") }
            reveal = Action.Reveal(
                replace: try r.string("replace", at: revealPath),
                with: try parseBlock(with, path: "\(revealPath).with")
            )
        }
        return Action(
            id: try object.string("id", at: path),
            label: try object.string("label", at: path),
            key: key,
            reveal: reveal
        )
    }

    public static func parseValue(_ json: JSON, path: String) throws -> Value {
        // A bare string where a value belongs is the commonest way to drop the reference.
        if case .string = json { throw PopupSpecError.missingReference(path: path) }
        let object = try json.object(path)
        let text = try object.string("text", at: path)
        guard let ref = object["ref"], ref != .null else { throw PopupSpecError.missingReference(path: path) }
        return Value(text, ref: try parseRef(ref, path: "\(path).ref"))
    }

    public static func parseRef(_ json: JSON, path: String) throws -> Ref {
        let object = try json.object(path)
        let kinds = ["node", "memory", "derived"].filter { object[$0] != nil }
        guard kinds.count == 1, let kind = kinds.first else {
            throw PopupSpecError.invalidReference(path: path, reason: "needs exactly one of node, memory, derived")
        }
        switch kind {
        case "node":
            let key = try object.string("node", at: path)
            guard !key.isEmpty else { throw PopupSpecError.invalidReference(path: path, reason: "empty node key") }
            return .node(key: key, quote: try object.optionalString("quote", at: path))
        case "memory":
            let id = try object.string("memory", at: path)
            guard !id.isEmpty else { throw PopupSpecError.invalidReference(path: path, reason: "empty memory id") }
            return .memory(id: id)
        default:
            let rule = try object.string("rule", at: path)
            let sources = try object.array("derived", at: path)
            guard !sources.isEmpty else {
                throw PopupSpecError.invalidReference(path: path, reason: "a derived value names no sources")
            }
            return .derived(rule: rule, from: try sources.enumerated().map { try parseRef($1, path: "\(path).derived[\($0)]") })
        }
    }
}

// MARK: - Encoding

extension PopupSpec {
    var json: JSON {
        .object(["v": .number(Double(Self.version)), "id": .string(id), "figure": .string(figure.rawValue), "blocks": .array(blocks.map(\.json))])
    }
}

extension PopupSpec.Block {
    var json: JSON {
        var o: [String: JSON] = ["type": .string(content.typeName)]
        if let id { o["id"] = .string(id) }
        switch content {
        case .header(let h):
            o["title"] = h.title.json
        case .facts(let f):
            o["rows"] = .array(f.rows.map { row in
                var r: [String: JSON] = ["value": row.value.json]
                if let label = row.label { r["label"] = .string(label) }
                if row.secondary { r["secondary"] = .bool(true) }
                return .object(r)
            })
        case .fields(let f):
            o["rows"] = .array(f.rows.map { row in
                var r: [String: JSON] = ["destination": row.destination.json, "state": .string(row.state.rawValue)]
                if let value = row.value { r["value"] = value.json }
                return .object(r)
            })
            if f.more > 0 { o["more"] = .number(Double(f.more)) }
        case .choices(let c):
            o["rows"] = .array(c.rows.map { row in
                var r: [String: JSON] = ["label": row.label.json]
                if let hint = row.hint { r["hint"] = hint.json }
                return .object(r)
            })
            o["selected"] = .number(Double(c.selected))
        case .diff(let d):
            o["before"] = d.before.json
            o["after"] = d.after.json
            if let label = d.label { o["label"] = .string(label) }
        case .steps(let s):
            o["rows"] = .array(s.rows.map { .object(["label": .string($0.label), "state": .string($0.state.rawValue)]) })
        case .source(let s):
            o["value"] = s.value.json
        case .actions(let a):
            o["items"] = .array(a.items.map(\.json))
        }
        return .object(o)
    }
}

extension PopupSpec.Action {
    var json: JSON {
        var r: [String: JSON] = ["id": .string(id), "label": .string(label), "key": .string(key.rawValue)]
        if let reveal {
            r["reveal"] = .object(["replace": .string(reveal.replace), "with": reveal.with.json])
        }
        return .object(r)
    }
}

extension PopupSpec.Block.Content {
    public var typeName: String {
        switch self {
        case .header: return "header"
        case .facts: return "facts"
        case .fields: return "fields"
        case .choices: return "choices"
        case .diff: return "diff"
        case .steps: return "steps"
        case .source: return "source"
        case .actions: return "actions"
        }
    }
}

extension PopupSpec.Value {
    var json: JSON { .object(["text": .string(text), "ref": ref.json]) }
}

extension PopupSpec.Ref {
    var json: JSON {
        switch self {
        case .node(let key, let quote):
            var o: [String: JSON] = ["node": .string(key)]
            if let quote { o["quote"] = .string(quote) }
            return .object(o)
        case .memory(let id):
            return .object(["memory": .string(id)])
        case .derived(let rule, let from):
            return .object(["rule": .string(rule), "derived": .array(from.map(\.json))])
        }
    }
}

// MARK: - A minimal JSON value

/// Raw JSON, decoded first so validation can name the exact path of a problem.
public enum JSON: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSON])
    case object([String: JSON])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSON].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSON].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n):
            if n == n.rounded(), abs(n) < 1e15 { try c.encode(Int64(n)) } else { try c.encode(n) }
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    public func object(_ path: String) throws -> [String: JSON] {
        guard case .object(let o) = self else { throw PopupSpecError.wrongType(path: path, expected: "object") }
        return o
    }
}

private extension Dictionary where Key == String, Value == JSON {
    func required(_ key: String, at path: String) throws -> JSON {
        guard let v = self[key], v != .null else { throw PopupSpecError.missingField(path: "\(path).\(key)") }
        return v
    }

    func string(_ key: String, at path: String) throws -> String {
        guard case .string(let s) = try required(key, at: path) else {
            throw PopupSpecError.wrongType(path: "\(path).\(key)", expected: "string")
        }
        return s
    }

    func optionalString(_ key: String, at path: String) throws -> String? {
        guard let v = self[key], v != .null else { return nil }
        guard case .string(let s) = v else { throw PopupSpecError.wrongType(path: "\(path).\(key)", expected: "string") }
        return s
    }

    // Int(exactly:) rather than Int(_:), which traps on a whole number past Int's range such as 1e300 (CodeRabbit on PR #4).
    func int(_ key: String, at path: String) throws -> Int {
        guard case .number(let n) = try required(key, at: path), let i = Int(exactly: n) else {
            throw PopupSpecError.wrongType(path: "\(path).\(key)", expected: "integer")
        }
        return i
    }

    func optionalInt(_ key: String, at path: String) throws -> Int? {
        guard let v = self[key], v != .null else { return nil }
        guard case .number(let n) = v, let i = Int(exactly: n), i >= 0 else {
            throw PopupSpecError.wrongType(path: "\(path).\(key)", expected: "non-negative integer")
        }
        return i
    }

    func optionalBool(_ key: String, at path: String) throws -> Bool? {
        guard let v = self[key], v != .null else { return nil }
        guard case .bool(let b) = v else { throw PopupSpecError.wrongType(path: "\(path).\(key)", expected: "boolean") }
        return b
    }

    func array(_ key: String, at path: String) throws -> [JSON] {
        guard case .array(let a) = try required(key, at: path) else {
            throw PopupSpecError.wrongType(path: "\(path).\(key)", expected: "array")
        }
        return a
    }

    func nonEmptyArray(_ key: String, at path: String) throws -> [JSON] {
        let a = try array(key, at: path)
        guard !a.isEmpty else { throw PopupSpecError.empty(path: "\(path).\(key)") }
        return a
    }

    func value(_ key: String, at path: String) throws -> PopupSpec.Value {
        try PopupSpec.parseValue(try required(key, at: path), path: "\(path).\(key)")
    }

    func optionalValue(_ key: String, at path: String) throws -> PopupSpec.Value? {
        guard let v = self[key], v != .null else { return nil }
        return try PopupSpec.parseValue(v, path: "\(path).\(key)")
    }
}
