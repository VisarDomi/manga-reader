import Foundation
import CoreGraphics
#if canImport(ImageIO)
import ImageIO
#endif
import KitCore
import KitNet
@testable import MangaLibrary
@testable import MangaSources

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
        retryScheduling()
        try retentionPolicy()
        try await retainedCache()
#if canImport(ImageIO)
        try await measuredDimensions()  // Apple's decoder and EXIF orientation: Mac only
#else
        print("SKIP: decoder canvas and orientation (ImageIO; run scripts/test.sh on the Mac to cover it)")
#endif
        try await metadataPriority()
        try await missingFileIndex()
        try await boundedLibraryWork()
        try await manifestCache()
        try await missingMetadataIndex()
        try await coverPreparationOrder()
        try await readerPairOverridesSavedPosition()
        try await foregroundRevokesBackgroundRefresh()
        try await PCRouteChecks.run()
    }

    @MainActor
    static func foregroundRevokesBackgroundRefresh() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let gate = TestGate()
        let library = Library(provider: SuspendedRefreshProvider(gate: gate), root: root, bundleID: "com.visar.HandoffCheck." + UUID().uuidString)
        let refresh = Task { await library.backgroundRefresh() }
        await gate.started()
        library.resumed()
        for _ in 0..<300 {
            if await library.images.state["active"] == 1 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let reclaimed = await library.images.state
        expect(reclaimed["active"] == 1, "Foreground reclaims image work while the old catalog refresh waits")
        await gate.release()
        await refresh.value
        let completed = await library.images.state
        expect(completed["active"] == 1, "A late background refresh cannot hand off or pause the new foreground owner")
        await library.images.setActive(false)
        print("PASS: foreground return revokes an in-flight background refresh/handoff")
    }

    @MainActor
    static func readerPairOverridesSavedPosition() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let files = ChapterFiles(directory: root)
        for chapter in 1...4 {
            let image = ChapterImage(url: "https://fixture.invalid/reader-\(chapter).jpg", width: 1, height: 1, dimensionsMeasured: true)
            await files.save(ChapterData(chapterId: String(chapter), seriesSlug: "fixture", seriesTitle: "Fixture", images: [image]), series: "fixture")
            if chapter <= 2 {
                let file = root.appendingPathComponent(ImageItem(url: image.url, cover: false).name)
                try DurableFile.write(Data([1, 2, 3]), to: file)
                try DurableFile.write(Data("image/jpeg".utf8), to: file.appendingPathExtension("mime"))
            }
        }
        await files.saveList(["4", "3", "2", "1"], series: "fixture")
        let state = ReadingState(directory: root, provider: "fixture")
        state.save(series: "fixture", chapterId: "1", imageIndex: 0, totalImages: 1); state.flush()
        let library = Library(provider: CoverOrderProvider(), root: root, bundleID: "com.visar.PairCheck." + UUID().uuidString)
        await library.images.setActive(false)
        let owner = NSObject()
        library.reading(owner, Library.Reading(series: "fixture", slug: "fixture", chapters: ["3"], chapter: "3", page: 0), visible: true)
        for _ in 0..<300 {
            if await library.images.state["planned"] ?? 0 > 0 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let plan = await library.images.unfinished(limit: 10), report = await library.images.storageReport
        expect(Set(plan.map(\.url)) == Set([3, 4].map { "https://fixture.invalid/reader-\($0).jpg" }), "Reader prepares only its visible current/next pair before progress settles")
        expect(report["currentNextFiles"] == 2 && report["expiringFiles"] == 2, "The former pair retires into grace instead of remaining active")
        expect(library.state.progress("fixture")?.chapterId == "1", "Preparation does not rewrite the saved resume position")
        print("PASS: visible reader overrides the saved pair without a scroll-end wait or resume mutation")
    }

    @MainActor
    static func coverPreparationOrder() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let cover = ImageItem(url: "https://fixture.invalid/cover.jpg", cover: true)
        let entry = HomeSeries(slug: "fixture", title: "Fixture", coverUrl: cover.url, chapters: [])
        try DurableFile.writeJSON(Catalog(series: [entry], complete: true), to: root.appendingPathComponent("catalog.json"))
        let files = ChapterFiles(directory: root)
        for chapter in ["1", "2"] {
            await files.save(ChapterData(chapterId: chapter, seriesSlug: "fixture", seriesTitle: "Fixture",
                                        images: [ChapterImage(url: "https://fixture.invalid/\(chapter).jpg", width: 1, height: 1, dimensionsMeasured: true)]), series: "fixture")
        }
        await files.saveList(["2", "1"], series: "fixture")
        let library = Library(provider: CoverOrderProvider(), root: root, bundleID: "com.visar.CoverOrder."+UUID().uuidString)
        await library.images.setActive(false)
        library.planSoon()
        for _ in 0..<500 {
            if await library.images.state["planned"] == 1 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let untouched = await library.images.unfinished(limit: 3)
        expect(untouched.count == 1 && untouched[0].cover, "Untouched series prepare only their cover")
        library.state.save(series: "fixture", chapterId: "1", imageIndex: 0, totalImages: 1)
        library.planSoon()
        for _ in 0..<500 {
            if await library.images.state["planned"] == 3 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let home = await library.images.unfinished(limit: 3)
        expect(home.count == 3 && home.first?.cover == true, "Home covers download before the catalog's background chapter bytes")
        let owner = NSObject()
        library.reading(owner, Library.Reading(series: "fixture", slug: "fixture", chapters: ["1"], chapter: "1", page: 0), visible: true)
        try await Task.sleep(for: .milliseconds(100))
        let reader = await library.images.unfinished(limit: 3)
        expect(reader.map(\.cover) == [false, false, true], "Reader current/next pages retain priority over covers")
        let file = library.images.url(cover)
        try DurableFile.write(Data([1, 2, 3]), to: file)
        try DurableFile.write(Data("image/jpeg".utf8), to: file.appendingPathExtension("mime"))
        await library.images.setRetained([])
        let reopened = ImageFiles(root: root, http: HTTPClient(.init()), referer: "https://fixture.invalid/")
        let retained = await reopened.isComplete(cover)
        expect(retained, "Cover bytes survive chapter pruning and a new cache instance")
        print("PASS: cover-first Home downloads, reader priority and permanent cover retention")
    }

    static func missingMetadataIndex() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let files = ChapterFiles(directory: root)
        for _ in 0..<20 {
            for number in 0..<100 {
                _ = await files.chapter("series-\(number)", "1")
                _ = await files.list("series-\(number)")
            }
        }
        let probes = await files.diskReads
        expect(probes == 200, "Missing manifests and lists are checked once instead of on every plan")
        await files.save(ChapterData(chapterId: "1", seriesSlug: "series-0", seriesTitle: "Fixture",
                                    images: [ChapterImage(url: "https://fixture.invalid/page.jpg", width: 1, height: 1)]), series: "series-0")
        await files.saveList(["2", "1"], series: "series-0")
        let chapter = await files.chapter("series-0", "1"), list = await files.list("series-0")
        expect(chapter != nil && list == ["2", "1"], "New metadata immediately replaces the missing-file index")
        print("PASS: 4,000 missing metadata lookups perform only 200 initial file reads")
    }

    static func manifestCache() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let files = ChapterFiles(directory: root)
        for chapter in 0..<200 {
            await files.save(ChapterData(chapterId: String(chapter), seriesSlug: "fixture", seriesTitle: "Fixture",
                                        images: [ChapterImage(url: "https://fixture.invalid/\(chapter).jpg", width: 1, height: 1)]), series: "fixture")
        }
        for _ in 0..<3 {
            for chapter in 0..<200 {
                let data = await files.chapter("fixture", String(chapter))
                expect(data != nil, "Warm manifest remains available")
            }
        }
        let reads = await files.diskReads
        expect(reads == 0, "Crossing 64 manifests never flushes the entire metadata cache")
        print("PASS: 600 warm manifest lookups perform zero disk reads")
    }

    @MainActor
    static func boundedLibraryWork() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let report = try await MangaWorkload.run(root: root)
        expect(report.completionReplans == 0, "Fifty completions never rebuild the catalog plan")
        expect(report.movementReplans == 0 && report.priorityUpdates > 0, "Page movement changes only reader priority")
        print("PASS: 5,000-page workload; zero completion/movement replans; completion CPU \(report.completionCPUSeconds)s")
    }

    static func missingFileIndex() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let files = ImageFiles(root: root, http: HTTPClient(.init()), referer: "https://fixture.invalid/")
        await files.setActive(false)
        let pages = (0..<5000).map { ImageItem(url: "https://fixture.invalid/\($0).jpg", cover: false) }
        await files.setPlan(pages)
        let names = pages.map(\.name)
        _ = await files.completed(names)
        let first = await files.state["fileChecks"]!
        for _ in 0..<20 { _ = await files.completed(names) }
        for page in 0..<100 { await files.prioritizeReader([pages[page]], awaitingMetadata: false) }
        let after = await files.state
        expect(first == 5000 && after["fileChecks"] == first, "Repeated completion checks and page priority changes do not stat missing files again")
        expect(after["planned"] == 5000, "Reader priority does not replace the Home preparation plan")
        print("PASS: 100,000 repeated cache checks cause zero additional filesystem probes")
    }

#if canImport(ImageIO)
    static func measuredDimensions() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let pixels = Data(repeating: 255, count: 12 * 20 * 4)
        let provider = CGDataProvider(data: pixels as CFData)!
        let bitmap = CGImage(width: 12, height: 20, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: 48,
                             space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
                             provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
        for orientation in 1...8 {
            let file = root.appendingPathComponent("orientation-\(orientation)")
            let destination = CGImageDestinationCreateWithURL(file as CFURL, "public.jpeg" as CFString, 1, nil)!
            CGImageDestinationAddImage(destination, bitmap, [kCGImagePropertyOrientation: orientation] as CFDictionary)
            expect(CGImageDestinationFinalize(destination), "Image fixture writes")
            let expected = orientation < 5 ? CGSize(width: 12, height: 20) : CGSize(width: 20, height: 12)
            expect(ImageDimensions.measure(file) == expected, "Decoder canvas applies orientation \(orientation)")
            expect(ImageDimensions.read(file) == expected, "Persisted dimensions survive a reopen")
        }
        let invalid = root.appendingPathComponent("invalid")
        try Data("not an image".utf8).write(to: invalid)
        expect(ImageDimensions.measure(invalid) == nil, "Unreadable bytes cannot publish page geometry")
        let files = ChapterFiles(directory: root)
        let chapter = ChapterData(chapterId: "1", seriesSlug: "s", seriesTitle: "Fixture",
                                  images: [ChapterImage(url: "https://fixture.invalid/page.jpg", width: 999, height: 1)])
        expect(!chapter.images[0].hasMeasuredDimensions, "Site attributes are not decoder measurements")
        await files.save(chapter, series: "s")
        await files.recordSizes([0: CGSize(width: 12, height: 20)], series: "s", chapterId: "1")
        let reopened = await ChapterFiles(directory: root).chapter("s", "1")!
        expect(reopened.images[0].hasMeasuredDimensions && reopened.images[0].width == 12 && reopened.images[0].height == 20,
               "Measured dimensions replace incorrect site metadata and persist")

        let images = ImageFiles(root: root, http: HTTPClient(.init()), referer: "https://fixture.invalid/")
        await images.setActive(false)
        let current = ImageItem(url: "https://fixture.invalid/current.jpg", cover: false)
        let other = ImageItem(url: "https://fixture.invalid/other.jpg", cover: false)
        await images.setPlan([current, other], readerNames: [current.name], awaitingReaderMetadata: true)
        let awaitingMetadata = await images.readerWorkPending()
        expect(awaitingMetadata, "Reader metadata blocks unrelated preparation")
        await images.setPlan([current, other], readerNames: [current.name])
        let awaitingBytes = await images.readerWorkPending()
        expect(awaitingBytes, "Reader image bytes block unrelated preparation")
        try DurableFile.write(try Data(contentsOf: root.appendingPathComponent("orientation-1")), to: images.url(current))
        try DurableFile.write(Data("image/jpeg".utf8), to: images.url(current).appendingPathExtension("mime"))
        await images.committed(current.name)
        let ready = await images.readerWorkPending()
        expect(!ready, "Unrelated entry work resumes as soon as the reader is ready")
        await images.invalidate(current)
        let invalidated = await images.isComplete(current)
        expect(!invalidated, "A failed cached decode can download fresh bytes on automatic retry")
        print("PASS: decoder dimensions, persisted correction and reader preparation barrier")
    }
#endif

    static func metadataPriority() async throws {
        let queue = MetadataQueue(), occupied = TestGate(), preparation = TestGate(), urgent = TestGate()
        let first = Task { try await queue.run(urgent: false, key: "first") { await occupied.wait() } }
        await occupied.started()
        await queue.setReaderBusy(true)
        let catalog = Task { try await queue.run(urgent: false, key: "catalog") { 1 } }
        let pages = Task { try await queue.run(urgent: false, key: "pages", preparation: true) { await preparation.wait() } }
        let screen = Task { try await queue.run(urgent: true, key: "screen") { await urgent.wait() } }
        await urgent.started()
        for _ in 0..<250 {
            if await queue.state["waiting"] == 2 { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        let held = await queue.state
        expect(held["running"] == 2 && held["waiting"] == 2, "Reader holds queued background metadata while urgent work proceeds")
        await queue.setReaderBusy(false)
        await urgent.release()
        _ = try await screen.value
        await preparation.started()
        let prioritized = await queue.state
        expect(prioritized["running"] == 2 && prioritized["waiting"] == 1, "Chapter preparation gets the released slot before catalog work")
        await occupied.release(); await preparation.release()
        _ = try await first.value; _ = try await pages.value; _ = try await catalog.value
        print("PASS: reader metadata priority and preparation before catalog")
    }

    static func retainedCache() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let files = ImageFiles(root: root, http: HTTPClient(.init()), referer: "https://fixture.invalid/")
        await files.setActive(false)
        let pages = (1...3).map { ImageItem(url: "https://fixture.invalid/chapter-\($0).jpg", cover: false) }
        for item in pages {
            let file = files.url(item)
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data([1, 2, 3]).write(to: file)
            try Data("image/jpeg".utf8).write(to: file.appendingPathExtension("mime"))
        }
        await files.setRetained(Set(pages.prefix(2).map(\.name)))
        let current = await files.isComplete(pages[0]), next = await files.isComplete(pages[1]), outside = await files.isComplete(pages[2])
        expect(current && next && !outside, "Initial cleanup keeps current/next and removes untouched excess")
        let now = Date()
        await files.setRetained([pages[1].name], now: now)
        let previous = await files.isComplete(pages[0]), kept = await files.isComplete(pages[1])
        expect(previous && kept, "Advancing retains downloaded previous pages for 24 hours")
        let reopened = ImageFiles(root: root, http: HTTPClient(.init()), referer: "https://fixture.invalid/")
        await reopened.setActive(false)
        await reopened.setRetained([pages[1].name], now: now.addingTimeInterval(PageRetention.grace + 1))
        let expired = await reopened.isComplete(pages[0]), active = await reopened.isComplete(pages[1])
        expect(!expired && active, "Restart preserves the original deadline and expires only retired pages")
        try DurableFile.write(Data([1, 2, 3]), to: reopened.url(pages[2]))
        try DurableFile.write(Data("image/jpeg".utf8), to: reopened.url(pages[2]).appendingPathExtension("mime"))
        await reopened.committed(pages[2].name)
        let late = await reopened.isComplete(pages[2])
        expect(!late, "A late background completion cannot recreate an unwanted page")
        print("PASS: touched current/next, durable 24-hour grace, expiry and late-completion cleanup")
    }

    static func retryScheduling() {
        var state = RetrySchedule()
        let now = Date(), late = state.schedule(now.addingTimeInterval(600))!
        let early = state.schedule(now.addingTimeInterval(15))!
        expect(state.schedule(now.addingTimeInterval(30)) == nil, "A later retry never delays the earliest waiting image")
        expect(!state.fire(late) && state.fire(early), "Old timer callbacks cannot clear a replacement retry")
        let pending = state.schedule(now)!
        state.cancel()
        expect(!state.fire(pending), "Suspending downloads revokes their old retry wake")
        print("PASS: earliest retry scheduling and stale/cancelled timer rejection")
    }

    static func retentionPolicy() throws {
        let now = Date(), existing: Set<String> = ["images/current", "images/old", "images/unread", "covers/a"]
        var policy = PageRetention()
        let initial = policy.reconcile(required: ["images/current"], existing: existing, migrationGrace: ["images/old"], now: now)
        expect(initial == ["images/unread"], "Migration cleans untouched pages immediately, preserving covers and touched history")
        let deadline = policy.expires["images/old"]
        _ = policy.reconcile(required: ["images/current"], existing: existing, migrationGrace: ["images/unread"], now: now.addingTimeInterval(60))
        expect(policy.expires["images/old"] == deadline && policy.expires["images/unread"] == nil, "Repeated planning neither extends grace nor restarts migration")
        _ = policy.reconcile(required: ["images/old"], existing: existing, migrationGrace: [], now: now.addingTimeInterval(120))
        expect(policy.expires["images/old"] == nil && policy.expires["images/current"] != nil, "Reactivation cancels expiry and retires the previous current page")
        var restored = try JSONDecoder().decode(PageRetention.self, from: JSONEncoder().encode(policy))
        let expired = restored.reconcile(required: ["images/old"], existing: existing, migrationGrace: [], now: now.addingTimeInterval(PageRetention.grace + 121))
        expect(expired == ["images/current", "images/unread"], "Persisted eviction expires retired bytes without deleting active pages or covers")
        print("PASS: one-time migration, durable deadlines, reactivation and permanent covers")
    }

    static func budget() async throws { try await RequestLimitChecks.run() }

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

        let violetHome = try Violet.parseHome(try fixture("violet-home.html"))
        expect(violetHome.nextCursor == "ajax:2" && violetHome.series.count == 39, "Violet Latest Comics (14 pinned, 25 newest)")
        let heiress = violetHome.series[0]
        expect(heiress.slug == "im-the-heiress-of-a-villainous-household" && heiress.title == "I’m the Heiress of a Villainous Household"
               && heiress.chapters[0].chapterId == "im-the-heiress-of-a-villainous-household-chapter-41" && heiress.chapters[0].label == "Chapter 41"
               && heiress.chapters[0].uploadedAt == "NEW" && !heiress.chapters[0].locked && heiress.coverUrl.hasPrefix("https://violetmanga.com/"), "Violet card")
        let empress = violetHome.series.first { $0.slug == "ill-quit-as-the-empress" }
        expect(empress?.chapters.first { $0.chapterId == "ill-quit-as-the-empress-chapter-21" }.map { $0.locked && $0.uploadedAt == "1 day ago" } == true,
               "Violet coin-locked chapter on Home")
        expect(violetHome.series.allSatisfy { !$0.chapters.contains { $0.chapterId.hasPrefix("comics") } }, "Violet All chapters link is not a chapter")
        let violetMore = try Violet.parseMore(try fixture("violet-more.html"), page: 2)
        expect(violetMore.series.count == 12 && violetMore.nextCursor == "ajax:3"
               && violetMore.series[0].slug == "the-reason-why-that-villainess-picked-up-a-sword", "Violet load more")
        let violetEnd = try Violet.parseMore(Data(#"{"success":false,"data":"No more posts"}"#.utf8), page: 55)
        expect(violetEnd.series.isEmpty && violetEnd.nextCursor == nil, "Violet catalog end")
        let violetChapter = try Violet.parseChapter(try text("violet-chapter.html"), slug: "bj-villainess", chapterId: "bj-villainess-chapter-46")
        expect(violetChapter?.images.count == 17 && violetChapter?.seriesTitle == "BJ Villainess"
               && violetChapter?.images[0].url == "https://violetmanga.com/wp-content/uploads/manga/14e1df4c/01.webp", "Violet chapter from reader data")
        expect(try Violet.parseChapter(try text("violet-locked.html"), slug: "ill-quit-as-the-empress", chapterId: "ill-quit-as-the-empress-chapter-21") == nil,
               "Violet coin-locked chapter is unavailable")
        let violetList = try Violet.parseList(try fixture("violet-series.html"))
        expect(violetList.count == 46 && violetList[0] == "bj-villainess-chapter-46" && violetList.last == "bj-villainess-chapter-1", "Violet chapter list")
        let violetLocked = try Violet.parseList(try fixture("violet-series-locked.html"))
        expect(violetLocked.count == 20 && violetLocked[0] == "ill-quit-as-the-empress-chapter-20", "Violet list leaves out coin-locked chapters")
        expect(Violet.route("/bj-villainess-chapter-46/")! == ("bj-villainess-chapter-46", "46") && Violet.route("/comics/bj-villainess/") == nil
               && Violet.route("/chapter-1/") == nil, "Violet routes")
        print("PASS: Violet")

        let yaksha = try Yaksha.parseHome(try fixture("yaksha-home.html"), page: 1)
        expect(yaksha.nextCursor == "2" && !yaksha.series.isEmpty && yaksha.series.allSatisfy { !$0.coverUrl.isEmpty }, "Yaksha home")
        expect(yaksha.series.contains { $0.chapters.contains { $0.uploadedAt?.isEmpty == false } }, "Yaksha dates")
        let yakshaChapter = try Yaksha.parseChapter(try text("yaksha-chapter.html"), slug: "the-mech-mechanic", chapterId: "chapter-7")
        expect(yakshaChapter?.images.count == 13 && yakshaChapter?.seriesTitle == "The Mech Mechanic" && yakshaChapter?.images[0].url.hasPrefix("https://") == true, "Yaksha chapter")
        expect(try Yaksha.parseChapter(try text("yaksha-missing.html"), slug: "the-mech-mechanic", chapterId: "chapter-9999") == nil, "Yaksha missing chapter is unavailable")
        expect(try Yaksha.parseList(try fixture("yaksha-series.html")).first == "chapter-7", "Yaksha list")
        let titled = Data(#"""
            <ul><li class="wp-manga-chapter"><a href="https://yakshacomics.com/manga/x/chapter-4/"> Chapter 4 </a></li>
            <li class="wp-manga-chapter"><a href="https://yakshacomics.com/manga/x/chapter-3/"> Chapter 3 - Ashen City </a></li>
            <li class="wp-manga-chapter"><a href="https://yakshacomics.com/manga/x/chapter-1/"> Chapter 1 </a></li>
            <li class="wp-manga-chapter"><a href="https://yakshacomics.com/manga/x/chapter-0/"> Chapter 0 - Introduction </a></li></ul>
            <div class="sidebar"><a href="https://yakshacomics.com/manga/y/chapter-133/">Chapter 133</a></div>
            """#.utf8)
        expect(try Yaksha.parseList(titled) == ["chapter-4", "chapter-3", "chapter-1", "chapter-0"], "Yaksha titled chapters keep their place")
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

private actor TestGate {
    private var didStart = false
    private var starters: [CheckedContinuation<Void, Never>] = []
    private var completion: CheckedContinuation<Void, Never>?
    func wait() async {
        didStart = true
        starters.forEach { $0.resume() }; starters.removeAll()
        await withCheckedContinuation { completion = $0 }
    }
    func started() async {
        if !didStart { await withCheckedContinuation { starters.append($0) } }
    }
    func release() { completion?.resume(); completion = nil }
}

private struct CoverOrderProvider: MangaProvider {
    let key = "fixture"
    let origin = URL(string: "https://fixture.invalid")!
    func home(_ cursor: String?) async throws -> HomePage { throw URLError(.notConnectedToInternet) }
    func chapter(_ slug: String, _ chapterId: String) async throws -> ChapterData? { throw URLError(.notConnectedToInternet) }
    func chaptersNewestFirst(_ slug: String) async throws -> [String] { throw URLError(.notConnectedToInternet) }
}

private struct SuspendedRefreshProvider: MangaProvider {
    let key = "fixture"
    let origin = URL(string: "https://fixture.invalid")!
    let gate: TestGate
    func home(_ cursor: String?) async throws -> HomePage { await gate.wait(); throw URLError(.notConnectedToInternet) }
    func chapter(_ slug: String, _ chapterId: String) async throws -> ChapterData? { nil }
    func chaptersNewestFirst(_ slug: String) async throws -> [String] { [] }
}
