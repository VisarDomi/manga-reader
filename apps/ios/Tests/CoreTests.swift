import Foundation

func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw ReaderError.message("FAIL: " + message) }
}
actor FakeAsura: AsuraSource {
    var requests = 0
    var offline = false
    func setOffline() { offline = true }
    func prioritize(_ url: String) {}
    func request(_ path: String, method: String, body: Data?, token: String?) async throws -> Data {
        if offline { throw ReaderError.message("Offline") }
        let chapters: [[String: Any]] = (1...4).map { ["number": $0, "is_premium": false] }
        if path.hasSuffix("/chapters") { return try jsonData(["data": chapters]) }
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
@main struct CoreTests {
    static func main() async throws {
        let chapters = [Chapter(number: "10"), Chapter(number: "2"), Chapter(number: "2.5"), Chapter(number: "1")]
        try expect(CachePolicy.window(current: "2", chapters: chapters) == ["2", "2.5"], "current plus immediate next, numeric order")
        try expect(CachePolicy.window(current: "10", chapters: chapters) == ["10"], "last chapter only")
        try expect(CachePolicy.window(current: "1", chapters: chapters) == ["1", "2"], "going back moves cache window")
        try expect(CachePolicy.window(current: "2", chapters: [Chapter(number: "2"), Chapter(number: "3", locked: true), Chapter(number: "4")]) == ["2", "3"], "never skip locked next to download a later chapter")
        print("PASS cache policy")
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
        let source = FakeAsura(), store = ReaderStore(root: root, source: source)
        try await store.load()
        try await store.importBackup(BackupCodec.encode(original))
        // One-page fixture position, and obsolete chapter image files.
        try await store.savePosition(Position(slug: "fixture", chapter: "2", page: 0, fraction: 0.4, total: 1, updatedAt: 2000))
        let obsolete = root.appendingPathComponent("images/\(CachePolicy.key("fixture", "1"))/0")
        try writeAtomically(Data("old image".utf8), obsolete)
        await store.setHome(true); await store.prepareHome()
        try expect(!FileManager.default.fileExists(atPath: obsolete.path), "obsolete image removed")
        for chapter in ["2", "3"] { try expect(FileManager.default.fileExists(atPath: root.appendingPathComponent("images/\(CachePolicy.key("fixture", chapter))/0").path), "current and next fully cached") }
        let downloadCount = await source.count(); try expect(downloadCount == 2, "only two chapters downloaded")
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
        let isolated = try BackupCodec.decode(scytheBackup, provider: .asura)
        try expect(isolated.progress.isEmpty, "provider backups remain isolated")
        try expect(ProviderConfiguration.scythe.identity("fixture-1234abcd") == "fixture-1234abcd", "Asura slug normalization never affects Scythe")
        print("PASS Scythe routes/default images/manual PC/provider isolation")
        if ProcessInfo.processInfo.environment["READER_LIVE_CHECK"] == "1" {
            let live = ScytheAPI()
            let catalog = try await live.catalog()
            try expect(!catalog.isEmpty, "live Scythe catalog")
            let series = catalog[0]
            let list = try await live.chapters(series.slug)
            let chapter = list.last!.key
            let manifest = try await live.manifest(series.slug, chapter, token: nil)
            let destination = root.appendingPathComponent("live-image")
            let mime = try await live.image(manifest.pages[0].url, to: destination, urgent: true)
            try expect(mime.hasPrefix("image/") && FileManager.default.fileExists(atPath: destination.path), "live Scythe image transfer")
            print("PASS live Scythe: \(catalog.count) series, \(list.count) chapters, \(manifest.pages.count) pages, image \(mime)")
        }
        if let fixture = ProcessInfo.processInfo.environment["SCYTHE_HOME_FIXTURE"] {
            let catalog = try ScytheParser.catalog(String(contentsOfFile: fixture, encoding: .utf8), path: "/")
            try expect(!catalog.series.isEmpty, "captured live Scythe home parsed")
            print("PASS captured Scythe home: \(catalog.series.count) series")
        }

    }
}
