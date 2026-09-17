import Foundation

actor ControlledTransfer: ImageTransfer {
    private var started: [String] = []
    private var waiting: [String: CheckedContinuation<Void, Error>] = [:]
    private var cancelled = Set<String>()
    func image(_ url: String, to file: URL, referrer: String) async throws -> String {
        started.append(url)
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
                if cancelled.remove(url) != nil { c.resume(throwing: CancellationError()) } else { waiting[url] = c }
            }
        } onCancel: { Task { await self.cancel(url) } }
        try Task.checkCancellation()
        try writeAtomically(Data(url.utf8), file)
        try writeAtomically(Data("image/png".utf8), file.appendingPathExtension("mime"))
        return "image/png"
    }
    func cancel(_ url: String) { if let waiter = waiting.removeValue(forKey: url) { waiter.resume(throwing: CancellationError()) } else { cancelled.insert(url) } }
    func complete(_ url: String) { waiting.removeValue(forKey: url)?.resume() }
    func starts() -> [String] { started }
}
func check(_ condition: Bool, _ message: String) throws {
    if !condition { throw ReaderError.message(message) }
}
func eventually(_ message: String, _ condition: @Sendable () async -> Bool) async throws {
    for _ in 0..<200 {
        if await condition() { return }
        try await Task.sleep(for: .milliseconds(10))
    }
    throw ReaderError.message(message)
}
@main struct Tests {
    static func main() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let transfer = ControlledTransfer()
        let downloader = ImageDownloader(root: root, transfer: transfer, referrer: "https://reader.test/")
        try await downloader.setRetained(Set(["a", "b", "c", "d", "e", "f"]))
        try await eventually("Three background slots") { await transfer.starts().count == 3 }
        let visible = Task { try await downloader.image("f", cover: false) }
        try await eventually("Visible request promotes an existing queued download") { Set(await transfer.starts()) == Set(["a","b","c","f"]) }
        let joined = Task { try await downloader.image("f", cover: false) }
        await transfer.complete("f")
        let (one, _) = try await visible.value, (two, _) = try await joined.value
        try check(one == two && String(decoding: one, as: UTF8.self) == "f", "Both callers receive the same file")
        let (cached, _) = try await downloader.image("f", cover: false)
        try check(cached == one, "Cached image is served immediately")
        try check(await transfer.starts().filter { $0 == "f" }.count == 1, "Single transfer per image")
        try await downloader.setRetained(Set(["f"]))
        try await eventually("Obsolete preparation is cancelled") { await downloader.diagnostics()["running"] == 0 }
        try check(FileManager.default.fileExists(atPath: root.appendingPathComponent("images/" + fileKey("f")).path), "Retained file survives")
        try await downloader.setRetained([])
        try await eventually("Obsolete file is deleted") { !FileManager.default.fileExists(atPath: root.appendingPathComponent("images/" + fileKey("f")).path) }
        await downloader.setActive(false)
        try await downloader.setRetained(Set(["g"]))
        try check(!(await transfer.starts()).contains("g"), "Background state does not start preparation")
        await downloader.setActive(true)
        try await eventually("Foreground resumes preparation") { await transfer.starts().contains("g") }
        await transfer.complete("g")
        try await eventually("Download completes") { await downloader.diagnostics()["running"] == 0 }
        try await downloader.setRetained([])
        await downloader.prepareCovers(Set(["cover-one", "cover-two"]))
        try await eventually("Offscreen covers download without image requests") { Set(await transfer.starts()).isSuperset(of: ["cover-one", "cover-two"]) }
        await transfer.complete("cover-one"); await transfer.complete("cover-two")
        try await eventually("Covers finish") { await downloader.diagnostics()["running"] == 0 }
        let (cover, _) = try await downloader.image("cover-two", cover: true)
        try check(String(decoding: cover, as: UTF8.self) == "cover-two", "Cover is served from disk")
        try check(await transfer.starts().filter { $0 == "cover-two" }.count == 1, "Cover is not fetched twice")
        print("PASS: shared image queue, visible priority, deduplication, disk cache, pruning, pause/resume")

        let store = ReaderStore(root: root.appendingPathComponent("store"), origin: "https://reader.test/")
        _ = try await store.command("downloads-active", data: Data("{\"active\":false}".utf8))
        _ = try await store.command("write", data: jsonData(["key":"database","value":["history":"keep"]]))
        _ = try await store.command("window", data: jsonData(["series":"one","keys":["prev","current","next"]]))
        for key in ["prev","current","next"] {
            _ = try await store.command("chapter-write", data: jsonData(["key":key,"value":["chapter":key]]))
            _ = try await store.command("prepare", data: jsonData(["key":key,"urls":["https://reader.test/"+key]]))
        }
        _ = try await store.command("window", data: jsonData(["series":"one","keys":["current","next","new"]]))
        let removed = try await store.command("chapter-read", data: jsonData(["key":"prev"]))
        try check(String(decoding: removed, as: UTF8.self) == "null", "Old chapter metadata is pruned with its images")
        let history = try await store.read("database")!
        try check(try object(history)["history"] as? String == "keep", "Pruning retains reading history")
        print("PASS: chapter window pruning retains history")
    }
}
