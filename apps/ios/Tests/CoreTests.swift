import Foundation

func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw ReaderError.message("FAIL: " + message) }
}
actor FakeAsura: AsuraSource {
    var requests = 0
    var offline = false
    var catalogRequests = 0
    var failCatalog = false
    var paths: [String] = []
    func requestedPaths() -> [String] { paths }
    func failLaterCatalog() { failCatalog = true }
    func catalogCount() -> Int { catalogRequests }
    func setOffline() { offline = true }
    func prioritize(_ url: String) {}
    func request(_ path: String, method: String, body: Data?) async throws -> Data {
        if offline { throw ReaderError.message("Offline") }
        guard path.hasPrefix("/series") else { throw ReaderError.message("Unexpected non-public request") }
        paths.append(path)
        if path.hasSuffix("/chapters/99") { throw ReaderError.http(404) }
        if path.hasSuffix("/chapters/100") { return try jsonData(["data": ["is_locked": true]]) }
        if path.hasPrefix("/series?") {
            catalogRequests += 1
            let first = path.hasSuffix("offset=0")
            guard first || path.hasSuffix("offset=50") else { throw ReaderError.message("Requested beyond final catalog page") }
            if !first && failCatalog { throw ReaderError.http(503) }
            let row: [String: Any] = ["slug":"fixture", "public_url":"/comics/fixture", "title":first ? "First title" : "Later title", "cover":"https://example.test/covers/a.webp", "latest_chapters":(first ? [2,10] : [10,3,1,9,8]).map { ["number":$0] }]
            var meta: [String: Any] = ["total": 1]
            if first { meta["has_more"] = true }
            return try jsonData(["data":[row],"meta":meta])
        }
        let chapters: [[String: Any]] = (1...4).reversed().map { ["number": $0, "is_premium": false] }
        if path.hasSuffix("/chapters") { return try jsonData(["data": chapters]) }
        try await Task.sleep(for: .milliseconds(20))
        let number = path.split(separator: "/").last.map(String.init) ?? "1"
        return try jsonData(["data": ["is_locked": false, "chapter": ["id": 42, "pages": [["url": "https://example.test/\(number).webp", "width": 0, "height": 0]]], "series": ["id": 12, "title": "Fixture"], "chapter_list": chapters]])
    }
    func image(_ raw: String, to destination: URL, urgent: Bool) async throws -> String {
        if offline { throw ReaderError.message("Offline") }; requests += 1
        try await Task.sleep(for: .milliseconds(20))
        try writeAtomically(Data("image".utf8), destination)
        try writeAtomically(Data("image/webp".utf8), destination.appendingPathExtension("mime"))
        return "image/webp"
    }
    func count() -> Int { requests }
}
actor CatalogProbe {
    private var batches: [(String, Int)] = []
    func record(_ snapshot: String, requests: Int) { batches.append((snapshot, requests)) }
    func values() -> [(String, Int)] { batches }
}
@main struct CoreTests {
    static func main() async throws {
        let chapters = [Chapter(number: "1"), Chapter(number: "2"), Chapter(number: "2.5"), Chapter(number: "10")]
        try expect(CachePolicy.window(current: "2", chapters: chapters) == ["2", "2.5", "1"], "current, next and previous in provider order")
        try expect(CachePolicy.window(current: "10", chapters: chapters) == ["10", "2.5"], "last chapter retains previous")
        try expect(CachePolicy.window(current: "1", chapters: chapters) == ["1", "2"], "going back moves cache window")
        try expect(CachePolicy.window(current: "2", chapters: [Chapter(number: "2"), Chapter(number: "3", locked: true), Chapter(number: "4")]) == ["2", "3"], "never skip locked next to download a later chapter")
        try expect(FakeAsura.coverURL("https://example.test/covers/a.webp?x=1") == "https://example.test/covers/a-400.webp?x=1", "Asura uses the userscript thumbnail size")
        let unusual = CachePolicy.oldestFirst([Chapter(number: "2", id: "chapter-2"), Chapter(number: "10", id: "chapter-10"), Chapter(number: "1", id: "chapter-1")])
        try expect(unusual.map(\.key) == ["chapter-1","chapter-10","chapter-2"], "provider order is not sorted by chapter number")
        try expect(CachePolicy.window(current: "chapter-1", chapters: unusual) == ["chapter-1","chapter-10"], "prefetch follows the same provider adjacency as Next")
        let repeatedNumber = CachePolicy.oldestFirst([Chapter(number: "2", id: "fixture-chapter-2"), Chapter(number: "2", id: "fixture-chapter-2-2"), Chapter(number: "1", id: "fixture-chapter-1")])
        try expect(CachePolicy.window(current: "fixture-chapter-1", chapters: repeatedNumber) == ["fixture-chapter-1","fixture-chapter-2-2"], "collision suffix remains a distinct adjacent chapter")
        print("PASS cache policy and provider order")
        var original = AppState()
        original.progress["fixture"] = Position(slug: "fixture-1234abcd", chapter: "2", page: 2, fraction: 0.472, total: 5, updatedAt: 1000)
        original.history["fixture"] = ["1": 9, "2": 2]
        let decoded = try BackupCodec.decode(BackupCodec.encode(original))
        try expect(decoded.progress["fixture"]?.fraction == 0.472 && decoded.history["fixture"]?["1"] == 9, "backup keeps fractional progress and older reading history")
        var invalid = try object(BackupCodec.encode(original)); invalid["version"] = 2
        do { _ = try BackupCodec.decode(jsonData(invalid)); throw ReaderError.message("Accepted invalid backup") } catch { try expect(error.localizedDescription != "Accepted invalid backup", "unsupported backup rejected") }
        print("PASS backup format and validation")
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let catalogSource = FakeAsura(), catalogStore = ReaderStore(root: root.appendingPathComponent("catalog"), source: catalogSource)
        let probe = CatalogProbe()
        try await catalogStore.refreshCatalog {
            let snapshot = try! await catalogStore.snapshot()
            await probe.record(snapshot, requests: catalogSource.catalogCount())
        }
        let batches = await probe.values()
        try expect(batches.count == 2 && batches[0].1 == 1, "first batch published before second request")
        let catalogRequests = await catalogSource.catalogCount()
        try expect(catalogRequests == 2, "missing has_more ends Asura pagination, like the userscript")
        let firstBatch = try object(Data(batches[0].0.utf8)), finalBatch = try object(Data(batches[1].0.utf8))
        try expect(firstBatch["catalogLoading"] as? Bool == true && finalBatch["catalogLoading"] as? Bool == false, "incremental progress becomes complete")
        let finalCatalog = finalBatch["catalog"] as! [[String: Any]], merged = finalCatalog[0]
        try expect(finalCatalog.count == 1 && merged["title"] as? String == "First title", "duplicate series merges without replacing first metadata")
        let keys = (merged["chapters"] as! [[String: Any]]).map { $0["number"] as! String }
        try expect(keys == ["9","1","3","10","2"], "source merge fills five slots in supplied order without sorting")
        await catalogSource.failLaterCatalog()
        do { try await catalogStore.refreshCatalog(); throw ReaderError.message("Expected catalog failure") }
        catch ReaderError.http(503) {}
        let partial = try object(Data(await catalogStore.snapshot().utf8))
        try expect((partial["catalog"] as? [Any])?.count == 1 && partial["catalogError"] != nil, "later failure keeps published rows and reports the error")
        print("PASS incremental catalog, source order, duplicate merge, metadata and partial failure")
        let source = FakeAsura(), store = ReaderStore(root: root, source: source)
        try await store.load()
        try await store.importBackup(BackupCodec.encode(original))
        // One-page fixture position, and obsolete chapter image files.
        try await store.savePosition(Position(slug: "fixture", chapter: "2", page: 0, fraction: 0.4, total: 1, updatedAt: 2000))
        let obsolete = root.appendingPathComponent("images/\(CachePolicy.key("fixture", "4"))/0")
        try writeAtomically(Data("old image".utf8), obsolete)
        await store.setPreparationContext(home: true, active: true); await store.waitForPreparation()
        try expect(!FileManager.default.fileExists(atPath: obsolete.path), "obsolete image removed")
        for chapter in ["1", "2", "3"] { try expect(FileManager.default.fileExists(atPath: root.appendingPathComponent("images/\(CachePolicy.key("fixture", chapter))/0").path), "previous, current and next fully cached") }
        let downloadCount = await source.count(); try expect(downloadCount == 3, "only three chapters downloaded")
        await store.setPreparationContext(home: true, active: false)
        try await store.importBackup(BackupCodec.encode(original))
        let snapshot = try object(Data(await store.snapshot().utf8))
        let progress = snapshot["progress"] as! [String: [String: Any]]
        try expect(progress["fixture"]?["updatedAt"] as? Double == 1000, "explicit Load replaces newer local progress")
        try expect((snapshot["history"] as? [String: [String: Int]])?["fixture"]?["1"] == 9, "pruning does not remove history")
        await source.setOffline()
        let m = try await store.manifest("fixture", "2")
        let page = try await store.page(m, 0, urgent: true)
        try expect(page.data == Data("image".utf8), "cached reader works with server offline")
        let checkpoint = try jsonData(["view": ["path": "/reader/fixture/2", "anchor": "page-2-0", "fraction": 0.4, "y": 1500],
                                       "progress": ["slug": "fixture", "chapter": "2", "page": 0, "fraction": 0.4, "total": 1, "updatedAt": 3000]])
        try await store.saveCheckpoint(checkpoint)
        let restarted = ReaderStore(root: root, source: source); try await restarted.load()
        let restoredSnapshot = try await restarted.snapshot(), previousSnapshot = try await store.snapshot(); try expect(restoredSnapshot == previousSnapshot, "cold restart preserves local state")
        let lastView = await restarted.lastView()
        try expect(lastView.path == "/reader/fixture/2" && lastView.anchor == "page-2-0" && lastView.fraction == 0.4, "cold restart preserves reader checkpoint with progress")
        print("PASS prepare/prune/history/replacement/offline/cold restart")
        try await store.importBackup(BackupCodec.encode(AppState()))
        let empty = try object(Data(await store.snapshot().utf8))
        try expect((empty["progress"] as? [String: Any])?.isEmpty == true, "explicit empty Load replaces local progress")
        try expect((empty["history"] as? [String: Any])?.isEmpty == true, "Load does not resurrect old history")
        print("PASS explicit PC replacement")
        let sharedRoot = root.appendingPathComponent("shared"), sharedSource = FakeAsura()
        let shared = ReaderStore(root: sharedRoot, source: sharedSource)
        let manifest = try await shared.manifest("fixture", "1")
        try expect(manifest.pages[0].width == 0, "missing Asura dimensions do not reject a chapter")
        async let one = shared.page(manifest, 0, urgent: false)
        async let two = shared.page(manifest, 0, urgent: true)
        _ = try await (one, two)
        let sharedCount = await sharedSource.count(); try expect(sharedCount == 1, "reader shares an in-flight prefetch")
        print("PASS shared transfer")
        let pc = PCBackup()
        try expect(!pc.configured, "unconfigured PC optional in test bundle")
        let available = await pc.available(); try expect(!available, "missing PC hides controls")
        print("PASS optional PC")
        let publicStore = ReaderStore(root: root.appendingPathComponent("public"), source: FakeAsura())
        for unavailable in ["99", "100"] {
            let result = try object(Data(await publicStore.webReply("open", data: jsonData(["slug":"fixture", "chapter":unavailable, "append":true])).utf8))
            try expect(result["unavailable"] as? Bool == true, "404 and locked chapter stop continuation without hiding current pages")
        }
        print("PASS public-only unavailable continuation")

        try await verifyRoutesAndDownloads(root: root)

        // Both provider chapter formats enter exactly the same checkpoint/history path.
        for chapter in ["2", "fixture-chapter-194-2"] {
            let isolatedRoot = root.appendingPathComponent(UUID().uuidString)
            let fresh = ReaderStore(root: isolatedRoot, source: FakeAsura())
            let saved = try jsonData(["view": ["path": "/reader/fixture/\(chapter)", "anchor": "page-\(chapter)-1", "fraction": 0.3, "y": 1200],
                                      "progress": ["slug": "fixture", "chapter": chapter, "page": 1, "fraction": 0.3, "total": 5, "updatedAt": 4000]])
            _ = try await fresh.webReply("view-save", data: saved)
            let cold = ReaderStore(root: isolatedRoot, source: FakeAsura())
            let state = try object(Data(await cold.webReply("snapshot", data: jsonData([:])).utf8))
            try expect((state["history"] as? [String: [String: Int]])?["fixture"]?[chapter] == 1, "fresh history persists for each provider chapter format")
            let progress = state["progress"] as? [String: [String: Any]]
            try expect(progress?["fixture"]?["chapter"] as? String == chapter && progress?["fixture"]?["fraction"] as? Double == 0.3, "fresh reading progress survives restart")
        }
        print("PASS both providers: empty history checkpoint and cold restart")
        let route = ScytheParser.route("fixture-chapter-194-2")
        try expect(route?.number == "194" && route?.slug == "fixture", "Scythe collision suffix is not the chapter number")
        let scytheList = try ScytheParser.chapters("<div id=chapterlist><a href='https://scythescans.com/fixture-chapter-194-2/'>194</a><a href='https://scythescans.com/fixture-chapter-1/'>1</a></div>", slug: "fixture")
        try expect(scytheList.first?.key == "fixture-chapter-1", "Scythe First chapter uses its real route")
        try expect(CachePolicy.window(current: "fixture-chapter-1", chapters: scytheList) == ["fixture-chapter-1", "fixture-chapter-194-2"], "shared cache window retains actual Scythe chapter IDs")
        let payload = try jsonData(["defaultSource": "B", "sources": [["source": "A", "images": ["https://example.test/wrong.jpg"]], ["source": "B", "images": ["https://example.test/right.jpg"]]]])
        let script = Data(("ts_reader.run(" + String(decoding: payload, as: UTF8.self) + ");").utf8).base64EncodedString()
        let parsed = try ScytheParser.reader("<div class=allc>All chapters are in <a>Fixture &amp; Title</a></div><script defer src='data:text/javascript;base64," + script + "'></script>")
        try expect(parsed.images == ["https://example.test/right.jpg"] && parsed.title == "Fixture & Title", "Scythe default image source and entity decoding")
        var scythe = AppState()
        scythe.progress["fixture"] = Position(slug: "fixture", chapter: "fixture-chapter-194-2", page: 1, fraction: 0.25, total: 3, updatedAt: 1000)
        scythe.history["fixture"] = ["fixture-chapter-1": 9]
        let scytheBackup = try BackupCodec.encode(scythe, provider: .scythe)
        let restoredScythe = try BackupCodec.decode(scytheBackup, provider: .scythe)
        try expect(restoredScythe.progress["fixture"]?.chapter == "fixture-chapter-194-2" && restoredScythe.progress["fixture"]?.fraction == 0.25 && restoredScythe.history["fixture"]?["fixture-chapter-1"] == 9, "Scythe manual PC format preserves route/fraction/history")
        do {
            _ = try BackupCodec.decode(scytheBackup, provider: .asura)
            throw ReaderError.message("Accepted wrong-provider backup")
        } catch ReaderError.message("Wrong provider in PC state") {}
        let beforeWrongImport = try await store.snapshot()
        do { try await store.importBackup(scytheBackup); throw ReaderError.message("Imported wrong-provider backup") }
        catch ReaderError.message("Wrong provider in PC state") {}
        let afterWrongImport = try await store.snapshot()
        try expect(beforeWrongImport == afterWrongImport, "wrong-provider Load does not erase existing history")
        try expect(ProviderConfiguration.scythe.identity("fixture-1234abcd") == "fixture-1234abcd", "Asura slug normalization never affects Scythe")
        let scytheOrder = try ScytheParser.chapters("<div id=chapterlist><a href='/fixture-chapter-2/'>2</a><a href='/fixture-chapter-10/'>10</a><a href='/fixture-chapter-10/'>10 duplicate</a><a href='/fixture-chapter-1/'>1</a></div>", slug: "fixture")
        try expect(scytheOrder.map(\.key) == ["fixture-chapter-1","fixture-chapter-10","fixture-chapter-2"], "Scythe dedupes in source order")
        let scytheCard = "<div class='listupd'><div class='bs'><div class='bsx'><a href='/manga/fixture/'><img src='/cover.jpg'><span class='tt'>Fixture</span></a><span class='epxs'>Volume 3</span></div></div></div>"
        let catalogWithoutChapter = try ScytheParser.catalog(scytheCard, path: "/manga/?page=1")
        try expect(catalogWithoutChapter.series.first?.chapters.isEmpty == true, "Scythe catalog never invents a chapter from a non-chapter label")
        print("PASS Scythe routes/default images/manual PC/provider isolation/order")
        if ProcessInfo.processInfo.environment["READER_LIVE_CHECK"] == "1" {
            let live = ScytheAPI()
            let catalog = try await live.catalog()
            try expect(!catalog.isEmpty, "live Scythe catalog")
            let series = catalog[0]
            let list = try await live.chapters(series.slug)
            let chapter = list.last!.key
            let manifest = try await live.manifest(series.slug, chapter)
            let destination = root.appendingPathComponent("live-image")
            let mime = try await live.image(manifest.pages[0].url, to: destination, urgent: true)
            try expect(mime.hasPrefix("image/") && FileManager.default.fileExists(atPath: destination.path), "live Scythe image transfer")
            print("PASS live Scythe: \(catalog.count) series, \(list.count) chapters, \(manifest.pages.count) pages, image \(mime)")
        }
        try expect(CachePolicy.validSlug("the-tyrant's-contract-mother") && CachePolicy.validSlug("a-中文-title"), "opaque provider slugs accepted")
        for bad in ["..", "a/b", "a?b", "a%2fb", "a\\b"] { try expect(!CachePolicy.validSlug(bad), "path separators rejected") }
        try expect(CachePolicy.validChapter("chapter-530.6"), "prefixed decimal chapter IDs accepted")
        let angular = try AngularAPI.chapter(object(jsonData(["slug": "chapter-530.6", "number": 530.6, "price": 100, "becameFreeAt": NSNull()])))
        try expect(angular.key == "chapter-530.6" && angular.number == "530.6" && angular.locked, "Angular chapter identity and paid state")
        let noCover = try AngularAPI.series(["slug": "april-fools", "title": "April Fools", "cover": NSNull()])
        try expect(noCover.cover.isEmpty && noCover.slug == "april-fools", "a missing cover does not block an otherwise valid catalog")
        let labeled = try LuaAPI.chapter(["chapter_slug": "chapter-999", "chapter_name": "  Chapter  12.5 Special "])
        try expect(labeled.number == "12.5" && labeled.label == "Chapter 12.5 Special", "Lua uses provider chapter label/number rather than reconstructing from route")
        let lua = try LuaAPI.reader("<title>Fixture - Chapter 1 - Lua Comic</title><img src='https://media.luacomic.org/file/a/uploads/series/one.webp'><img src='https://media.luacomic.org/file/a/cover.webp'>")
        try expect(lua.title == "Fixture" && lua.pages.count == 1, "Lua reader excludes covers")
        let yaksha = try YakshaAPI.reader("<ol class='breadcrumb'><a href='/manga/fixture/'>Fixture &amp; Title</a></ol><img class='wp-manga-chapter-img' src='https://example.test/page.jpg'>")
        try expect(yaksha.title == "Fixture & Title" && yaksha.pages.count == 1, "Yaksha reader images/title")
        let yakshaList = try YakshaAPI.chapters("<li class='wp-manga-chapter'><a href='/manga/fixture/chapter-2.5/'>Chapter 2.5</a></li><li class='wp-manga-chapter'><a href='/manga/fixture/chapter-1/'>Chapter 1</a></li>")
        try expect(yakshaList.map(\.key) == ["chapter-1", "chapter-2.5"], "Yaksha preserves chapter links and provider order")
        let yakshaOrder = try YakshaAPI.chapters("<li class='wp-manga-chapter'><a href='/manga/fixture/chapter-2/'>Chapter 2</a></li><li class='wp-manga-chapter'><a href='/manga/fixture/chapter-10/'>Chapter 10</a></li><li class='wp-manga-chapter'><a href='/manga/fixture/chapter-1/'>Chapter 1</a></li>")
        try expect(yakshaOrder.map(\.key) == ["chapter-1","chapter-10","chapter-2"], "Yaksha preserves the provider order")
        let yakshaLabels = try YakshaAPI.chapters("<li class='wp-manga-chapter'><a href='/manga/fixture/alternate/'>Chapter 2</a></li><li class='wp-manga-chapter'><a href='/manga/fixture/extra/'>Announcement</a></li>")
        try expect(yakshaLabels.map(\.key) == ["chapter-2"], "Yaksha chapter IDs/filter match the userscript's chapter labels")

        for provider in [ProviderConfiguration.ezmanga, .qiscans, .lua, .yaksha] {
            var state = AppState()
            state.progress["the-tyrant's-mother"] = Position(slug: "the-tyrant's-mother", chapter: "chapter-2.5", page: 1, fraction: 0.3, total: 4, updatedAt: 100)
            let roundtrip = try BackupCodec.decode(BackupCodec.encode(state, provider: provider), provider: provider)
            try expect(roundtrip.progress["the-tyrant's-mother"]?.fraction == 0.3, "every provider's manual PC round trip")
        }
        print("PASS additional providers: parser/opaque IDs/manual backup")
        if let names = ProcessInfo.processInfo.environment["READER_LIVE_PROVIDERS"] {
            for name in names.split(separator: ",") {
                guard let provider = ProviderConfiguration(rawValue: String(name)) else { throw ReaderError.message("Unknown live test provider") }
                let source = provider.makeSource()
                let catalog = try await source.catalog()
                guard let series = catalog.first(where: { $0.chapters.contains(where: { !$0.locked }) }), let selected = series.chapters.last(where: { !$0.locked }) else { throw ReaderError.message("No free chapter in catalog") }
                let list = try await source.chapters(series.slug)
                try expect(list.contains { $0.key == selected.key } && Set(list.map(\.key)).count == list.count, "live provider chapter list contains selected chapter without duplicates")
                let manifest = try await source.manifest(series.slug, selected.key)
                let file = root.appendingPathComponent("live-" + provider.rawValue)
                let mime = try await source.image(manifest.pages[0].url, to: file, urgent: true)
                try expect(mime.hasPrefix("image/"), "live provider reader and image")
                print("PASS live \(provider.rawValue): \(catalog.count) series, \(manifest.pages.count) pages, \(mime)")
            }
        }
        if let fixture = ProcessInfo.processInfo.environment["SCYTHE_HOME_FIXTURE"] {
            let catalog = try ScytheParser.catalog(String(contentsOfFile: fixture, encoding: .utf8), path: "/")
            try expect(!catalog.series.isEmpty, "captured live Scythe home parsed")
            print("PASS captured Scythe home: \(catalog.series.count) series")
        }

    }
    static func verifyRoutesAndDownloads(root: URL) async throws {
        // Asura changes only the public URL suffix. Cached chapters must not
        // leak that old route into Next, local images, or future checkpoints.
        let oldSlug = "the-magic-towers-problem-child-53fc8424", freshSlug = "the-magic-towers-problem-child-6f7fe6eb"
        let rotationRoot = root.appendingPathComponent("rotation"), rotationSource = FakeAsura()
        let rotation = ReaderStore(root: rotationRoot, source: rotationSource)
        let oldManifest = try await rotation.manifest(oldSlug, "61")
        _ = try await rotation.manifest(freshSlug, "62")
        let memoryResume = try await rotation.manifest(freshSlug, "61")
        try expect(memoryResume.slug == freshSlug && memoryResume.key == oldManifest.key, "memory resume reuses downloads with the requested route")
        let rotationCold = ReaderStore(root: rotationRoot, source: rotationSource)
        await rotationSource.setOffline()
        for routeSlug in [freshSlug, oldSlug] {
            let resume = try await rotationCold.manifest(routeSlug, "61")
            let next = try await rotationCold.manifest(routeSlug, "62")
            try expect(resume.slug == routeSlug && next.slug == resume.slug, "cold resume and cached Next share a route after URL rotation")
        }
        let raceRoot = root.appendingPathComponent("rotation-race"), raceSource = FakeAsura()
        let race = ReaderStore(root: raceRoot, source: raceSource)
        async let oldRequest = race.manifest(oldSlug, "61")
        async let newRequest = race.manifest(freshSlug, "61")
        let (oldResult, newResult) = try await (oldRequest, newRequest)
        try expect(oldResult.slug == oldSlug && newResult.slug == freshSlug, "shared in-flight manifest returns each caller's route")
        let manifestCalls = await raceSource.requestedPaths()
        try expect(manifestCalls.count == 1, "URL rotation still shares one manifest download")
        print("PASS rotating Asura routes: memory, disk, offline Next, concurrent requests")

        let movingRoot = root.appendingPathComponent("moving"), movingSource = FakeAsura()
        let moving = ReaderStore(root: movingRoot, source: movingSource)
        for slug in ["fixture", "other"] {
            try await moving.savePosition(Position(slug: slug, chapter: "2", page: 0, fraction: 0.4, total: 1, updatedAt: 1))
        }
        await moving.setPreparationContext(home: true, active: true)
        await moving.waitForPreparation()
        func imageExists(_ slug: String, _ chapter: String) -> Bool {
            FileManager.default.fileExists(atPath: movingRoot.appendingPathComponent("images/\(CachePolicy.key(slug, chapter))/0").path)
        }
        func readerCheckpoint(_ chapter: String) throws -> Data {
            try jsonData(["view": ["path": "/reader/fixture/\(chapter)", "anchor": "page-\(chapter)-0", "fraction": 0.4, "y": 1500],
                          "progress": ["slug": "fixture", "chapter": chapter, "page": 0, "fraction": 0.4, "total": 1, "updatedAt": 2000]])
        }
        let beforeReadingCalls = await movingSource.requestedPaths()
        await moving.setPreparationContext(home: false, active: true)
        try await moving.saveCheckpoint(readerCheckpoint("3"))
        await moving.waitForPreparation()
        try expect(!imageExists("fixture", "1") && ["2", "3", "4"].allSatisfy { imageExists("fixture", $0) }, "reader advance moves disk window without visiting Home")
        try expect(!FileManager.default.fileExists(atPath: movingRoot.appendingPathComponent("manifests/\(CachePolicy.key("fixture", "1")).json").path), "obsolete manifest removed with images")
        try expect(["1", "2", "3"].allSatisfy { imageExists("other", $0) }, "reading one manga preserves another manga's downloads")
        let afterReadingCalls = await movingSource.requestedPaths()
        try expect(!afterReadingCalls.dropFirst(beforeReadingCalls.count).contains { $0.contains("/other/") }, "reader does not refresh unrelated manga")
        try await moving.saveCheckpoint(readerCheckpoint("1"))
        // Move again while obsolete work may still be downloading.
        try await moving.saveCheckpoint(readerCheckpoint("4"))
        await moving.waitForPreparation()
        try expect(!imageExists("fixture", "1") && !imageExists("fixture", "2") && imageExists("fixture", "3") && imageExists("fixture", "4"), "rapid jumps settle on the final window, not a stale preparation")
        await moving.setPreparationContext(home: false, active: false)
        try await moving.saveCheckpoint(readerCheckpoint("1"))
        await moving.waitForPreparation()
        try expect(!imageExists("fixture", "1"), "backgrounded app does not begin new preparations")
        await moving.setPreparationContext(home: false, active: true)
        await moving.waitForPreparation()
        try expect(imageExists("fixture", "1") && imageExists("fixture", "2") && !imageExists("fixture", "3") && !imageExists("fixture", "4"), "foreground resumes the current first-chapter window")
        let movingSnapshot = try object(Data(await moving.snapshot().utf8))
        let movingHistory = movingSnapshot["history"] as! [String: [String: Int]]
        try expect(movingHistory["fixture"]?["4"] == 0 && movingHistory["fixture"]?["3"] == 0, "deleting chapter files retains reading history")
        await moving.setPreparationContext(home: false, active: false)
        let lateManifest = try await moving.manifest("fixture", "4")
        async let lateOne = moving.page(lateManifest, 0, urgent: true)
        async let lateTwo = moving.page(lateManifest, 0, urgent: true)
        let (lateFirst, lateSecond) = try await (lateOne, lateTwo)
        try expect(lateFirst.data == Data("image".utf8) && lateSecond.data == lateFirst.data, "shared obsolete readers finish safely")
        try expect(!imageExists("fixture", "4"), "late out-of-window image completion does not resurrect deleted downloads")
        print("PASS previous/current/next: Home, reader transitions, first/last, rapid jumps, pause/resume, other series and history")

    }

}
