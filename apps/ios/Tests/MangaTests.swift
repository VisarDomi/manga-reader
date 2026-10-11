import Foundation

func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) {
    do { if try !condition() { print("FAIL: " + message); exit(1) } }
    catch { print("FAIL: \(message): \(error)"); exit(1) }
}

func fixture(_ name: String) throws -> Data {
    try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent(name))
}

func text(_ name: String) throws -> String { String(decoding: try fixture(name), as: UTF8.self) }

@main
struct MangaTests {
    static func main() async throws {
        try providers()
        try store()
        try await budget()
    }

    // Background work stops at its share of the minute; work for the screen goes on.
    static func budget() async throws {
        let limiter = RequestLimiter(.init(perMinute: 3, background: 1))
        try await limiter.acquire(host: "a", urgency: nil)
        let passed = Urgency(false)
        let waiting = Task { try await limiter.acquire(host: "a", urgency: nil); passed.raise() }
        let urgent = Urgency(true)
        let started = Date()
        try await limiter.acquire(host: "a", urgency: urgent)
        try await limiter.acquire(host: "a", urgency: urgent)
        expect(Date().timeIntervalSince(started) < 0.5, "Urgent requests pass while background waits")
        try await Task.sleep(for: .milliseconds(700))
        expect(!passed.value, "Background request still waiting")
        try await limiter.acquire(host: "b", urgency: nil)
        expect(true, "Another host has its own budget")
        waiting.cancel()
        await limiter.throttled(host: "c", retryAfter: 1)
        let held = Date()
        try await limiter.acquire(host: "c", urgency: urgent)
        expect(Date().timeIntervalSince(held) >= 0.9, "A 429 holds the host's requests until its wait is over")
        print("PASS: request budget")
    }

    static func providers() throws {
        let now = Date()
        let asura = try Asura.parseHome(try fixture("asura-home.json"), page: 1, now: now)
        expect(asura.series.count == 12 && asura.nextCursor == "2" && asura.prefetchCursors == ["2", "3", "4"] && asura.total == 354, "Asura home page and cursors")
        let first = asura.series[0]
        expect(first.slug == "pick-up-a-grimoire-become-a-mage-bd5bdaf8" && first.historyId == "pick-up-a-grimoire-become-a-mage", "Asura slug keeps its suffix, identity drops it")
        expect(first.coverUrl.hasSuffix(".1bf474-400.webp") && first.chapters.first?.chapterId == "6" && first.chapters.first?.label == "Chapter 6", "Asura cover and chapters")
        expect(try Asura.parseHome(try fixture("asura-last.json"), page: 8, now: now).nextCursor == nil, "Asura's last page omits has_more")
        expect(Asura.historyId("solo-leveling-0a1b2c3d") == "solo-leveling" && Asura.historyId("solo-leveling") == "solo-leveling", "Asura identity")
        let asuraChapter = try Asura.parseChapter(try fixture("asura-chapter.json"), slug: "pick-up-a-grimoire-become-a-mage", chapterId: "1")
        expect(asuraChapter?.images.isEmpty == false && asuraChapter?.images[0].width != nil && asuraChapter?.seriesTitle.isEmpty == false, "Asura chapter pages with sizes")
        expect(try Asura.parseList(try fixture("asura-chapters.json")).first == "6", "Asura list newest first")
        print("PASS: Asura")

        let ez = try Angular.parseHome(try fixture("ez-latest.json"), latest: true, page: 1, now: now)
        expect(ez.nextCursor == "latest:2" && ez.prefetchCursors == ["latest:2", "latest:3", "latest:4"] && ez.total == 763, "EzScans latest page")
        let asha = ez.series[0]
        expect(asha.slug == "asha-of-the-borderlands" && asha.chapters[0].locked && asha.chapters[0].unlockAt == nil && !asha.chapters[2].locked, "EzScans paid chapters are locked")
        let catalog = try Angular.parseHome(try fixture("ez-catalog.json"), latest: false, page: 1, now: now)
        expect(catalog.nextCursor == "catalog:2" && !catalog.series.isEmpty, "EzScans catalog page")
        expect(try Angular.parseChapter(try fixture("ez-chapter.json"), slug: "asha-of-the-borderlands", chapterId: "chapter-17")?.images.isEmpty == false, "EzScans chapter")
        expect(try Angular.parseChapter(try fixture("ez-chapter-locked.json"), slug: "asha-of-the-borderlands", chapterId: "chapter-19") == nil, "EzScans paid chapter is unavailable")
        let ezList = try Angular.parseListPage(try fixture("ez-chapters.json"), page: 1)
        expect(ezList.chapters.first == "chapter-19" && !ezList.more, "EzScans list")
        expect(try Angular.parseHome(try fixture("qi-latest.json"), latest: true, page: 1, now: now).series[0].slug == "rebirth-monarch-of-the-dead", "QiScans latest page")
        let broken = Data(#"{"data":[{"slug":"a","title":"A","cover":null},{"slug":"b"},{"slug":"c","title":"C","cover":"https://x/c.webp","chapters":[]}],"totalItems":3,"totalPages":1}"#.utf8)
        let lenient = try Angular.parseHome(broken, latest: false, page: 1, now: now)
        expect(lenient.series.map(\.slug) == ["a", "c"] && lenient.series[0].coverUrl.isEmpty && lenient.nextCursor == nil, "A series without a cover stays; an incomplete one is skipped")
        expect((try? Angular.parseHome(Data(#"{"data":[{"slug":"b"}],"totalItems":1,"totalPages":1}"#.utf8), latest: false, page: 1, now: now)) == nil, "A page with nothing readable fails")
        print("PASS: EzScans, QiScans")

        let lua = try Lua.parseHome(try fixture("lua-home.json"), cursor: nil, page: 1)
        expect(lua.nextCursor == "all:1" && lua.total == 662 && lua.series[0].chapters.first?.chapterId == "chapter-79" && lua.series[0].chapters.first?.label == "Chapter 79", "Lua home")
        let luaChapter = try Lua.parseChapter(try text("lua-chapter.html"), slug: "i-am-living-an-unmarried-life-with-a-terminally-ill-lover", chapterId: "chapter-79")
        expect(!luaChapter.images.isEmpty && luaChapter.images.allSatisfy { $0.url.hasPrefix("https://media.luacomic.org/file/") } && !luaChapter.seriesTitle.isEmpty, "Lua chapter images and title")
        let luaList = try Lua.parseListPage(try fixture("lua-chapters.json"))
        expect(luaList.last == 3 && luaList.chapters.count == 30 && luaList.chapters[0] == "chapter-79", "Lua list page")
        print("PASS: Lua")

        let scytheHome = try Scythe.parseHome(try fixture("scythe-home.html"), page: 1)
        expect(scytheHome.nextCursor == "home:2" && !scytheHome.series.isEmpty, "Scythe latest updates")
        let fall = scytheHome.series[0]
        expect(fall.slug == "defiance-of-the-fall" && fall.title == "Defiance of the Fall" && fall.chapters[0].chapterId == "defiance-of-the-fall-chapter-36"
               && fall.chapters[0].label == "Chapter 36" && fall.chapters[0].uploadedAt == "20 seconds ago" && fall.coverUrl.hasPrefix("https://"), "Scythe card")
        let scytheCatalog = try Scythe.parseCatalog(try fixture("scythe-catalog.html"), page: 1)
        expect(scytheCatalog.nextCursor == "catalog:2" && scytheCatalog.series[1].chapters.first?.chapterId == "magic-emperor-chapter-920", "Scythe catalog")
        let scytheChapter = try Scythe.parseChapter(try text("scythe-chapter.html"), slug: "magic-emperor", chapterId: "magic-emperor-chapter-920")
        expect(scytheChapter.images.count == 7 && scytheChapter.seriesTitle == "Magic Emperor", "Scythe chapter from reader data")
        let listed = try Scythe.parseListed(try fixture("scythe-series.html"), slug: "magic-emperor")
        expect(listed.count == 920 && listed[0] == "magic-emperor-chapter-920", "Scythe chapter list")
        expect(Scythe.route("/worlds-strongest-troll-chapter-194-2/")! == ("worlds-strongest-troll", "worlds-strongest-troll-chapter-194-2", "194"), "Scythe collision suffix")
        expect(Scythe.route("/manga/x/") == nil && Scythe.route("/chapter-1/") == nil, "Scythe non-chapter paths")
        print("PASS: Scythe")

        let yaksha = try Yaksha.parseHome(try fixture("yaksha-home.html"), page: 1)
        expect(yaksha.nextCursor == "2" && !yaksha.series.isEmpty && yaksha.series.allSatisfy { !$0.coverUrl.isEmpty }, "Yaksha home")
        expect(yaksha.series.contains { $0.chapters.contains { $0.uploadedAt?.isEmpty == false } }, "Yaksha dates")
        let yakshaChapter = try Yaksha.parseChapter(try text("yaksha-chapter.html"), slug: "the-mech-mechanic", chapterId: "chapter-7")
        expect(yakshaChapter?.images.count == 13 && yakshaChapter?.seriesTitle == "The Mech Mechanic" && yakshaChapter?.images[0].url.hasPrefix("https://") == true, "Yaksha chapter")
        expect(try Yaksha.parseChapter(try text("yaksha-missing.html"), slug: "the-mech-mechanic", chapterId: "chapter-9999") == nil, "Yaksha missing chapter is unavailable")
        expect(Yaksha.parseList(try text("yaksha-series.html")).first == "chapter-7", "Yaksha list")
        print("PASS: Yaksha")

        expect(SiteDate.parse("2026-10-10T16:08:04.666458Z") != nil && SiteDate.parse("2026-10-11T14:40:56.627Z") != nil && SiteDate.parse("October 5, 2026") != nil
               && SiteDate.parse("2 days ago") == nil, "Site dates")
        expect(Web.number(12) == "12" && Web.number(12.5) == "12.5", "Chapter numbers as JavaScript writes them")
        expect(Web.query([("tags_ids", "[]"), ("query", "")]) == "tags_ids=%5B%5D&query=", "Queries as URLSearchParams writes them")
        print("PASS: shared parsing")
    }

    static func store() throws {
        // The web version's keys (JSON.stringify) and file names.
        expect(FileKey.chapter("solo", "12") == #"["solo","12"]"# && FileKey.list("solo") == #"["chapters","solo"]"#, "Chapter keys")
        expect(FileKey.stringify(["a\"b\\c\n"]) == #"["a\"b\\c\n"]"#, "Escaping")
        expect(FileKey.sha256("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "SHA-256 names")

        // Schema 1 (per chapter) to 3, keeping the latest per series; Asura suffixes fold.
        let v1 = #"{"version":1,"indexedDB":{"progress":[{"id":"asurascans\u0000solo-0a1b2c3d\u00001","provider":"asurascans","seriesSlug":"solo-0a1b2c3d","chapterId":"1","imageIndex":3,"totalImages":10,"updatedAt":100},{"id":"asurascans\u0000solo-0a1b2c3d\u00002","provider":"asurascans","seriesSlug":"solo-0a1b2c3d","chapterId":"2","imageIndex":9,"totalImages":10,"updatedAt":200},{"id":"asurascans\u0000solo\u00003","provider":"asurascans","seriesSlug":"solo","chapterId":"0","imageIndex":0,"totalImages":5,"updatedAt":50}],"tokens":[{"key":"t","value":{"a":[1,null,"x"]}}],"metadata":[{"key":"asura-ios-v1","value":{"history":{}}}]}}"#
        let migrated = try Database.load(Data(v1.utf8))
        let entries = migrated.database.indexedDB.progress
        expect(migrated.changed && entries.count == 1 && entries[0].seriesSlug == "solo" && entries[0].chapterId == "2" && entries[0].id == "asurascans\u{0}solo", "Migration to schema 3")
        expect(migrated.database.indexedDB.tokens[0].value == .object(["a": .array([.number(1), .null, .string("x")])]), "Unknown rows kept")
        expect(migrated.database.indexedDB.metadata.contains { $0.key == "asura-ios-v1" } && migrated.database.indexedDB.metadata.last == .init(key: "progress-schema-version", value: .number(3)), "Schema recorded")
        let encoded = try ReadingState.encode(migrated.database)
        _ = try Database.validate(encoded)
        expect(try Database.load(encoded).changed == false, "Schema 3 stays as it is")
        do { _ = try Database.validate(Data(#"{"version":1,"indexedDB":{"progress":[],"tokens":[],"metadata":[]}}"#.utf8)); expect(false, "Schema required") } catch {}
        do { _ = try Database.validate(Data(#"{"version":1,"indexedDB":{"progress":[{"id":"x","provider":"asurascans","seriesSlug":"s","chapterId":"1","imageIndex":5,"totalImages":5,"updatedAt":1}],"tokens":[],"metadata":[{"key":"progress-schema-version","value":3}]}}"#.utf8)); expect(false, "Out of range page") } catch {}
        print("PASS: reading state format, migrations and validation")

        expect(withNewerChapters(["3", "2", "1"], ["5", "4", "3", "2"]) == ["5", "4", "3", "2", "1"], "Newer chapters join a list")
        expect(withNewerChapters(["3", "2", "1"], ["5", "3", "1"]) == ["3", "2", "1"], "A selection that skips is not joined")
        expect(withNewerChapters(["3", "2", "1"], ["4", "3"]) == ["3", "2", "1"], "One overlapping chapter is not enough")
        let id: (HomeSeries) -> String = { $0.slug }
        let a = HomeSeries(slug: "a", title: "A", coverUrl: "", chapters: []), b = HomeSeries(slug: "b", title: "B", coverUrl: "", chapters: [])
        let c = HomeSeries(slug: "c", title: "C", coverUrl: "", chapters: [])
        let newB = HomeSeries(slug: "b", title: "B", coverUrl: "", chapters: [HomeChapter(chapterId: "9", label: "Chapter 9", uploadedAt: nil, locked: false, unlockAt: nil)])
        expect(Catalog.merged([a, b, c], fresh: [newB], identity: id) == [newB, a, c], "An updated series moves to the top, the rest keep their order")
        print("PASS: chapter lists and catalog merge")
    }
}
