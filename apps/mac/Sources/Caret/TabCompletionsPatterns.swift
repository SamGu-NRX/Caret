import Foundation

enum TabCompletionsPatterns {
    private static let patternLine = try! NSRegularExpression(
        pattern: #"^\s*(?:\d+\.|[-*])\s+(.+)$"#,
        options: []
    )

    static func instructionPatterns(from instructions: String) -> [String] {
        var patterns: [String] = []
        for line in instructions.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty || trimmed.lowercased().hasPrefix("when ") {
                continue
            }
            let ns = String(line) as NSString
            let range = NSRange(location: 0, length: ns.length)
            guard let match = patternLine.firstMatch(in: String(line), range: range),
                  match.numberOfRanges > 1
            else { continue }
            let captured = ns.substring(with: match.range(at: 1)).trimmingCharacters(in: .whitespacesAndNewlines)
            if !captured.isEmpty {
                patterns.append(captured)
            }
        }
        return patterns
    }

    /// Candidates to match against instruction bullets (full tail, current line, current token).
    static func typingTokens(from fullPrefix: String) -> [String] {
        guard !fullPrefix.isEmpty else { return [] }
        var raw: [String] = [fullPrefix]
        if let newline = fullPrefix.range(of: "\n", options: .backwards) {
            raw.append(String(fullPrefix[newline.upperBound...]))
        }
        if let word = fullPrefix.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).last {
            raw.append(String(word))
        }
        var seen = Set<String>()
        var ordered: [String] = []
        for token in raw.sorted(by: { $0.count > $1.count }) {
            if seen.insert(token).inserted {
                ordered.append(token)
            }
        }
        return ordered
    }

    static func meetsMinimumTyping(_ fullPrefix: String) -> Bool {
        typingTokens(from: fullPrefix).contains { $0.count >= TabCompletions.minimumTypedCharacters }
    }

    static func longestEligibleToken(_ fullPrefix: String) -> String? {
        typingTokens(from: fullPrefix)
            .filter { $0.count >= TabCompletions.minimumTypedCharacters }
            .max(by: { $0.count < $1.count })
    }

    static func completionMatch(
        fullPrefix: String,
        instructions: String
    ) -> (token: String, suffix: String)? {
        for token in typingTokens(from: fullPrefix) {
            guard token.count >= TabCompletions.minimumTypedCharacters else { continue }
            let suffix = completionSuffixForToken(token, instructions: instructions)
            if !suffix.isEmpty {
                return (token, suffix)
            }
        }
        return nil
    }

    static func completionSuffix(prefix: String, instructions: String) -> String {
        completionMatch(fullPrefix: prefix, instructions: instructions)?.suffix ?? ""
    }

    private static func completionSuffixForToken(_ typed: String, instructions: String) -> String {
        guard !typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return "" }

        var bestSuffix = ""
        var bestPatternLength = -1
        for pattern in instructionPatterns(from: instructions) {
            let shared = sharedPrefixLength(typed: typed, pattern: pattern)
            guard shared == typed.count, shared < pattern.count else { continue }
            let start = pattern.index(pattern.startIndex, offsetBy: shared)
            let suffix = String(pattern[start...])
            if pattern.count > bestPatternLength {
                bestSuffix = suffix
                bestPatternLength = pattern.count
            }
        }
        return bestSuffix
    }

    private static func sharedPrefixLength(typed: String, pattern: String) -> Int {
        let typedScalars = Array(typed)
        let patternScalars = Array(pattern)
        let limit = min(typedScalars.count, patternScalars.count)
        var index = 0
        while index < limit {
            if typedScalars[index].lowercased() != patternScalars[index].lowercased() {
                break
            }
            index += 1
        }
        return index
    }
}
