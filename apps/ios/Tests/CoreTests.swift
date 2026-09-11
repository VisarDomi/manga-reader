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
        let restarted = ReaderStore(root: root, source: source); try await restarted.load()
        let restoredSnapshot = try await restarted.snapshot(), previousSnapshot = try await store.snapshot(); try expect(restoredSnapshot == previousSnapshot, "cold restart preserves local state")
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
    }
}
