import XCTest
@testable import CaretHostCore

/// Each kind of memory row reads like a person wrote it: the title says what Caret remembers, the
/// secondary line says where it came from and how sure Caret is. Composed from the entry's fields,
/// never from the helper's sentence, so these pin the exact words.
final class MemoryWordingTests: XCTestCase {
    /// 2026-09-21 09:14:20 CDT, the memory fixture's About entry.
    static let seenMs: Int64 = 1_790_000_060_000
    let now = Date(timeIntervalSince1970: 1_790_000_160)
    var calendar: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/Chicago")!
        return c
    }
    let locale = Locale(identifier: "en_US")

    /// macOS puts a narrow no-break space before AM and PM.
    var nineFourteen: String {
        let f = DateFormatter()
        f.locale = locale
        f.timeZone = calendar.timeZone
        f.dateStyle = .none
        f.timeStyle = .short
        return f.string(from: Date(timeIntervalSince1970: Double(Self.seenMs) / 1000))
    }

    private func entry(_ fields: HelperMemory.Fields, status: HelperMemory.Status = .active, count: Int = 1, app: String? = "Mail", id: String = "e1") -> HelperMemory.Entry {
        HelperMemory.Entry(id: id, status: status, says: "the helper's sentence, never shown", evidence: .init(count: count, lastSeen: Self.seenMs, app: app), fields: fields)
    }

    private func words(_ e: HelperMemory.Entry, with others: [HelperMemory.Entry] = []) -> [String] {
        let w = MemoryPage.wording(e, entries: [e] + others, now: now, calendar: calendar, locale: locale)
        return [w.title, w.secondary]
    }

    func testTheTimeIsTheOneTheFormatterWrites() {
        XCTAssertEqual(nineFourteen.replacingOccurrences(of: "\u{202F}", with: " "), "9:14 AM")
    }

    // MARK: - About you

    func testAboutYouSaysYourLabelIsTheValue() {
        XCTAssertEqual(words(entry(.about(.init(label: "Guest", value: "Marcus Lowe (ops)", source: .edit)))),
                       ["Your guest is Marcus Lowe (ops)", "You set this · today \(nineFourteen) · Mail"])
        XCTAssertEqual(words(entry(.about(.init(label: "Email", value: "dana@example.com", source: .typed)), app: nil)),
                       ["Your email is dana@example.com", "You typed this · today \(nineFourteen)"])
        XCTAssertEqual(words(entry(.about(.init(label: "Phone", value: "512-555-0100", source: .contacts)), status: .paused)),
                       ["Your phone is 512-555-0100", "Paused · from your Contacts card · today \(nineFourteen) · Mail"])
    }

    func testAnInitialismKeepsItsCapitals() {
        XCTAssertEqual(MemoryPage.aboutTitle(label: "ZIP code", value: "78701"), "Your ZIP code is 78701")
        XCTAssertEqual(MemoryPage.aboutTitle(label: "Work email", value: "d@example.com"), "Your work email is d@example.com")
    }

    func testATypedValueTheHelperHasNotKeptSaysSo() {
        let row = MemoryPage.typedRow(MemoryBook.Typed(id: "typed-1", label: "Name", value: "Dana Whitfield", phase: .waiting))
        XCTAssertEqual([row.title, row.secondary], ["Your name is Dana Whitfield", "You typed this during setup · not saved yet"])
    }

    // MARK: - People

    func testPeopleSayWhoANameMeansInWhichApp() {
        XCTAssertEqual(words(entry(.people(.init(alias: "Dana", name: "Dana Reyes")), status: .paused, count: 3)),
                       ["Dana in Mail means Dana Reyes", "Paused · picked 3 times"])
        XCTAssertEqual(words(entry(.people(.init(alias: "Sam", name: "Sam Okafor")), count: 1, app: nil)),
                       ["Sam means Sam Okafor", "Picked once"])
    }

    // MARK: - Preferences

    func testAPhoneFormatShowsSampleDigits() {
        XCTAssertEqual(words(entry(.preference(.format(template: "###-###-####")), count: 2, app: "Caret Fixture")),
                       ["Phone numbers go in as 512-555-0100", "You changed it twice · today \(nineFourteen)"])
        XCTAssertEqual(words(entry(.preference(.format(template: "(###) ###-####")), count: 3)),
                       ["Phone numbers go in as (512) 555-0100", "You changed it 3 times · today \(nineFourteen)"])
    }

    func testUseInsteadQuotesTheAboutValueItUses() {
        let about = entry(.about(.init(label: "Guest", value: "Marcus Lowe (ops)", source: .edit)), id: "about-1")
        let pref = entry(.preference(.useInstead(field: "Guest", aboutId: "about-1")), id: "pref-1")
        XCTAssertEqual(words(pref, with: [about]), ["Guest fields get Marcus Lowe (ops)", "You changed it once · today \(nineFourteen)"])
        XCTAssertEqual(words(pref), ["Guest fields get a value Caret no longer has", "You changed it once · today \(nineFourteen)"])
        let pausedAbout = entry(.about(.init(label: "Guest", value: "Marcus Lowe (ops)", source: .edit)), status: .paused, id: "about-1")
        XCTAssertEqual(words(pref, with: [pausedAbout])[0], "Guest fields would get Marcus Lowe (ops), but it's paused",
                       "the helper substitutes nothing from a paused entry")
    }

    func testDontOfferNamesWhatStopped() {
        XCTAssertEqual(words(entry(.preference(.dontOffer(offerKind: "routine", appName: "Mail")))),
                       ["No routine offers in Mail", "You turned this off · today \(nineFourteen)"])
        XCTAssertEqual(words(entry(.preference(.dontOffer(offerKind: "loopNext", appName: "Numbers"))))[0], "No next-row suggestions in Numbers")
        XCTAssertEqual(words(entry(.preference(.dontOffer(offerKind: "loopFinish", appName: "Numbers"))))[0], "No offers to finish the rest in Numbers")
    }

    // MARK: - Routines

    private func routine(_ src: [String], steps: Int = 3, name: String? = nil, hits: Int, misses: Int) -> HelperMemory.Fields {
        .routine(.init(srcApps: src, dstApp: "Mail", steps: steps, name: name, silent: .init(hits: hits, misses: misses)))
    }

    func testARoutineSaysWhatItCopiesAndHowOftenItWasRight() {
        XCTAssertEqual(words(entry(routine(["Caret Fixture"], hits: 1, misses: 2), status: .learning, count: 3)),
                       ["Copies 3 values from Caret Fixture into Mail", "Still learning · right 1 of 3 times"])
        XCTAssertEqual(words(entry(routine(["Notes", "Safari"], steps: 1, hits: 0, misses: 0), status: .learning, count: 2)),
                       ["Copies 1 value from Notes and Safari into Mail", "Still learning · seen twice"])
        XCTAssertEqual(words(entry(routine(["Notes"], hits: 1, misses: 0), status: .learning)),
                       ["Copies 3 values from Notes into Mail", "Still learning · right the one time so far"])
        XCTAssertEqual(words(entry(routine(["Notes", "Safari", "Numbers"], hits: 5, misses: 1), count: 6)),
                       ["Copies 3 values from Notes, Safari and Numbers into Mail", "Learned · right 5 of 6 times"])
        XCTAssertEqual(words(entry(routine(["Notes"], hits: 2, misses: 1), status: .paused)),
                       ["Copies 3 values from Notes into Mail", "Paused · right 2 of 3 times"])
    }

    func testANamedRoutineLeadsWithItsName() {
        XCTAssertEqual(words(entry(routine(["Notes"], name: "Weekly invoice", hits: 1, misses: 2), status: .learning)),
                       ["Weekly invoice", "Copies 3 values from Notes into Mail · still learning · right 1 of 3 times"])
    }

    // MARK: - No helper jargon anywhere

    func testNoRowCarriesTheHelpersSentenceOrItsJargon() throws {
        let fixture = try HelperMemoryTests.reply(1)
        var state = MemoryBook.State()
        state.entries = fixture.entries
        state.connected = true
        state.loaded = true
        for section in MemoryPage.sections(state, now: now, calendar: calendar, locale: locale) {
            for row in section.rows {
                for text in [row.title, row.secondary] {
                    XCTAssertFalse(text.contains("silent"), text)
                    XCTAssertFalse(text.contains("(from your edit)"), text)
                    XCTAssertFalse(text.contains(") ("), "stacked parentheses: \(text)")
                    XCTAssertFalse(text.contains("Last seen"), text)
                }
            }
        }
    }
}
