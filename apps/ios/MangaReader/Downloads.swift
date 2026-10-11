import Foundation
import KitCore
import KitNet

// MARK: - Site work (chapters, lists, catalog pages): what the screen waits for first

// Up to six pieces of work for the screen at once. Background work (two at a time) waits while
// any of those runs, so a chapter being opened never shares the site with the plan's lists or
// the catalog. Work the screen asks for while it waits or runs becomes urgent (Urgency, read
// by each of its requests through SiteClient).
actor MetadataQueue {
    private struct Waiter { let id: UUID; let key: String?; let urgency: Urgency; let continuation: CheckedContinuation<Bool, Never> }
    private var running: [UUID: (key: String?, urgency: Urgency)] = [:]
    private var waiting: [Waiter] = []

    func run<T: Sendable>(urgent: Bool, key: String?, _ work: @Sendable () async throws -> T) async throws -> T {
        let id = UUID(), urgency = Urgency(urgent)
        guard await acquire(id: id, key: key, urgency: urgency) else { throw CancellationError() }
        defer { release(id) }
        return try await SiteClient.$urgency.withValue(urgency) { try await work() }
    }

    func prioritize(_ key: String) {
        for item in running.values where item.key == key { item.urgency.raise() }
        for waiter in waiting where waiter.key == key { waiter.urgency.raise() }
        pump()
    }

    private func acquire(id: UUID, key: String?, urgency: Urgency) async -> Bool {
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                waiting.append(Waiter(id: id, key: key, urgency: urgency, continuation: continuation))
                pump()
            }
        } onCancel: {
            Task { await self.cancel(id) }
        }
    }

    private func cancel(_ id: UUID) {
        guard let index = waiting.firstIndex(where: { $0.id == id }) else { return }
        waiting.remove(at: index).continuation.resume(returning: false)
    }

    private func release(_ id: UUID) {
        running[id] = nil
        pump()
    }

    private func pump() {
        while !waiting.isEmpty {
            let index: Int
            if let urgent = waiting.firstIndex(where: { $0.urgency.value }) {
                guard running.count < 6 else { return }
                index = urgent
            } else {
                guard running.count < 2, !running.values.contains(where: { $0.urgency.value }) else { return }
                index = 0
            }
            let waiter = waiting.remove(at: index)
            running[waiter.id] = (waiter.key, waiter.urgency)
            waiter.continuation.resume(returning: true)
        }
    }

    var state: [String: Int] {
        ["running": running.count, "urgent": running.values.filter { $0.urgency.value }.count, "waiting": waiting.count]
    }
}

// MARK: - Chapters and chapter lists: the phone's copy first, the site when needed

actor ChapterSource {
    let provider: any MangaProvider
    let files: ChapterFiles
    private let queue = MetadataQueue()
    private var chapterTasks: [String: Task<ChapterData?, Error>] = [:]
    private var listTasks: [String: Task<[String], Error>] = [:]
    private var oldestTasks: [String: Task<String?, Error>] = [:]
    // Each series' Home row (newest first): it can be ahead of a kept list.
    private var rows: [String: [String]] = [:]
    private var lists: [String: [String]] = [:]
    private var listChecked: [String: Date] = [:]
    private var listeners: [@Sendable (String) -> Void] = []

    init(provider: any MangaProvider, files: ChapterFiles) {
        self.provider = provider
        self.files = files
    }

    func onListChange(_ listener: @escaping @Sendable (String) -> Void) { listeners.append(listener) }

    // A chapter's pages (nil: unavailable). The saved file answers at once; otherwise one
    // request per chapter, ahead of background work when `urgent`.
    func chapter(series: String, slug: String, chapterId: String, urgent: Bool) async throws -> ChapterData? {
        if let saved = await files.chapter(series, chapterId) { return saved }
        let key = FileKey.chapter(series, chapterId)
        if urgent { await queue.prioritize(key) }
        if let task = chapterTasks[key] { return try await task.value }
        let task = Task { [provider, queue, files] () throws -> ChapterData? in
            let data = try await queue.run(urgent: urgent, key: key) { try await provider.chapter(slug, chapterId) }
            if let data { await files.save(data, series: series) }
            return data
        }
        chapterTasks[key] = task
        defer { chapterTasks[key] = nil }
        return try await task.value
    }

    func savedChapter(series: String, chapterId: String) async -> ChapterData? { await files.chapter(series, chapterId) }

    // A series' first chapter for opening it: the kept list's, else the site's (urgent; most
    // sites answer without the whole list).
    func oldest(series: String, slug: String) async throws -> String? {
        if let list = await knownList(series: series) { return list.last }
        let key = "oldest:" + series
        if let task = oldestTasks[series] { return try await task.value }
        let task = Task { [provider, queue] in try await queue.run(urgent: true, key: key) { try await provider.oldestChapter(slug) } }
        oldestTasks[series] = task
        defer { oldestTasks[series] = nil }
        return try await task.value
    }

    // Other site work in the background (the catalog's pages).
    func background<T: Sendable>(_ work: @Sendable () async throws -> T) async throws -> T {
        try await queue.run(urgent: false, key: nil, work)
    }

    var queueState: [String: Int] { get async { await queue.state } }

    // The list as known now (kept, then extended by the Home row); nil before the first fetch.
    func knownList(series: String) async -> [String]? {
        var list = lists[series]
        if list == nil, let saved = await files.list(series) { list = saved }
        guard let list else { return nil }
        let extended = rows[series].map { withNewerChapters(list, $0) } ?? list
        if lists[series] != extended {
            lists[series] = extended
            if extended != list { await files.saveList(extended, series: series) }
        }
        return extended
    }

    // The site's list (one request per series at a time), extended by the Home row and kept.
    func fetchList(series: String, slug: String, urgent: Bool) async throws -> [String] {
        let key = "list:" + series
        if urgent { await queue.prioritize(key) }
        if let task = listTasks[series] { return try await task.value }
        let task = Task { [provider, queue] in try await queue.run(urgent: urgent, key: key) { try await provider.chaptersNewestFirst(slug) } }
        listTasks[series] = task
        defer { listTasks[series] = nil }
        let fresh = try await task.value
        listChecked[series] = Date()
        let list = rows[series].map { withNewerChapters(fresh, $0) } ?? fresh
        var previous = lists[series]
        if previous == nil { previous = await files.list(series) }
        if list != previous {
            lists[series] = list
            await files.saveList(list, series: series)
            if previous != nil { notify(series) }
        } else {
            await files.touchList(series)
        }
        return list
    }

    // Since the site was last asked (kept across launches as the list file's date, so a
    // relaunch does not ask for every started series' list again).
    func listAge(_ series: String) async -> TimeInterval {
        if listChecked[series] == nil { listChecked[series] = await files.listChecked(series) }
        return listChecked[series].map { Date().timeIntervalSince($0) } ?? .infinity
    }

    // The catalog's rows; a row showing a newer chapter moves that series' next chapter.
    func setRows(_ updated: [String: [String]]) async {
        for (series, row) in updated {
            guard rows[series] != row else { continue }
            rows[series] = row
            var list = lists[series]
            if list == nil { list = await files.list(series) }
            if let list, withNewerChapters(list, row) != list { notify(series) }
        }
    }

    private func notify(_ series: String) { for listener in listeners { listener(series) } }
}

// MARK: - Image files (images/ and covers/, <sha256(url)> plus a .mime marker of completion)

struct ImageItem: Hashable, Sendable {
    let url: String
    let cover: Bool
    var name: String { (cover ? "covers/" : "images/") + FileKey.sha256(url) }
}

// The only owner of image bytes. Pages on screen load first (shared per image, dropped when
// nobody waits); then the planned work in order: the chapters being read, every started
// series' current and next chapter, then the catalog's covers. Images outside what is kept
// are deleted; covers are kept.
actor ImageFiles {
    private struct Transfer { let id = UUID(); let task: Task<URL, Error>; var callers: Set<UUID> = [] }
    let root: URL
    private let http: HTTPClient
    private let referer: String
    private var foreground: [String: Transfer] = [:]
    private var background: [String: Task<Void, Never>] = [:]
    private var plan: [ImageItem] = []
    private var done = Set<String>()
    private var failed: [String: (attempts: Int, retryAt: Date)] = [:]
    private var retained: Set<String>?
    private var scanned = false
    private var active = true
    private var wakeScheduled = false
    private var observers: [@Sendable (ImageItem) -> Void] = []

    init(root: URL, http: HTTPClient, referer: String) {
        self.root = root
        self.http = http
        self.referer = referer
    }

    nonisolated func url(_ item: ImageItem) -> URL { root.appendingPathComponent(item.name) }

    private func complete(_ item: ImageItem) -> Bool {
        if done.contains(item.name) { return true }
        let file = url(item)
        guard FileManager.default.fileExists(atPath: file.appendingPathExtension("mime").path), (DurableFile.size(file) ?? 0) > 0 else { return false }
        done.insert(item.name)
        return true
    }

    func isComplete(_ item: ImageItem) -> Bool { complete(item) }

    // Which of these files are complete.
    func completed(_ names: [String]) -> [String] {
        names.filter { name in
            if done.contains(name) { return true }
            let file = root.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: file.appendingPathExtension("mime").path), (DurableFile.size(file) ?? 0) > 0 else { return false }
            done.insert(name)
            return true
        }
    }

    func onFinished(_ observer: @escaping @Sendable (ImageItem) -> Void) { observers.append(observer) }

    // An image someone is looking at.
    func file(_ item: ImageItem) async throws -> URL {
        if complete(item) { return url(item) }
        try Task.checkCancellation()
        // On screen now: a slow background transfer of it gives way to an urgent one.
        background.removeValue(forKey: item.name)?.cancel()
        if foreground[item.name] == nil {
            foreground[item.name] = Transfer(task: Task { [http, referer, root] in
                try await Self.download(item, http: http, referer: referer, root: root, priority: URLSessionTask.highPriority)
            })
        }
        let caller = UUID()
        foreground[item.name]!.callers.insert(caller)
        let transfer = foreground[item.name]!
        defer {
            if foreground[item.name]?.id == transfer.id {
                foreground[item.name] = nil
                pump()
            }
        }
        let file = try await withTaskCancellationHandler {
            try await transfer.task.value
        } onCancel: {
            Task { await self.abandon(item.name, transfer: transfer.id, caller: caller) }
        }
        finished(item)
        return file
    }

    private func abandon(_ name: String, transfer: UUID, caller: UUID) {
        guard foreground[name]?.id == transfer else { return }
        foreground[name]!.callers.remove(caller)
        guard foreground[name]!.callers.isEmpty else { return }
        foreground[name]!.task.cancel()
        foreground[name] = nil
        pump()
    }

    private static func download(_ item: ImageItem, http: HTTPClient, referer: String, root: URL, priority: Float) async throws -> URL {
        guard let source = URL(string: item.url), source.scheme == "https" else { throw ProviderError.invalid("Invalid image URL") }
        let file = root.appendingPathComponent(item.name)
        let response = try await http.download(HTTPRequest(source, referer: referer, priority: priority), to: file) { response in
            guard response.statusCode == 200, response.mimeType?.hasPrefix("image/") == true else { throw URLError(.badServerResponse) }
        }
        try DurableFile.write(Data((response.mimeType ?? "image/jpeg").utf8), to: file.appendingPathExtension("mime"))
        return file
    }

    private func finished(_ item: ImageItem) {
        done.insert(item.name)
        failed[item.name] = nil
        for observer in observers { observer(item) }
    }

    // What to download, in order (replacing the previous plan).
    func setPlan(_ items: [ImageItem]) {
        plan = items
        let wanted = Set(items.map(\.name))
        for (name, task) in background where !wanted.contains(name) { task.cancel() }
        pump()
    }

    // Images to keep (covers are always kept); others are deleted.
    func setRetained(_ names: Set<String>) async {
        let previous = retained
        retained = names
        let removed = previous.map { $0.subtracting(names) } ?? []
        for name in removed where foreground[name] == nil && background[name] == nil { remove(name) }
        guard !scanned else { return }
        scanned = true
        let folder = root.appendingPathComponent("images")
        let entries = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
        for entry in entries where !entry.hasSuffix(".mime") && !entry.hasPrefix(".") {
            let name = "images/" + entry
            if retained?.contains(name) == false, foreground[name] == nil, background[name] == nil { remove(name) }
            await Task.yield()
        }
    }

    private func remove(_ name: String) {
        let file = root.appendingPathComponent(name)
        try? FileManager.default.removeItem(at: file)
        try? FileManager.default.removeItem(at: file.appendingPathExtension("mime"))
        done.remove(name)
    }

    // Paused while the app is away (the background session carries on).
    func setActive(_ value: Bool) {
        active = value
        if !value { for task in background.values { task.cancel() } }
        pump()
    }

    // The unfinished planned work, in order.
    func unfinished(limit: Int) -> [ImageItem] {
        var result: [ImageItem] = []
        for item in plan where !complete(item) {
            result.append(item)
            if result.count == limit { break }
        }
        return result
    }

    func committed(_ name: String) { done.insert(name) }

    private func pump() {
        guard active else { return }
        let limit = foreground.isEmpty ? 3 : 1
        guard background.count < limit else { return }
        let now = Date()
        for item in plan {
            guard background.count < limit else { return }
            if background[item.name] != nil || foreground[item.name] != nil || complete(item) { continue }
            if let failure = failed[item.name], failure.retryAt > now { continue }
            background[item.name] = Task(priority: .utility) { [http, referer, root] in
                let outcome: Error?
                do {
                    _ = try await Self.download(item, http: http, referer: referer, root: root, priority: URLSessionTask.lowPriority)
                    outcome = nil
                } catch { outcome = error }
                self.backgroundFinished(item, error: outcome)
            }
        }
        if !wakeScheduled, let next = failed.values.map(\.retryAt).filter({ $0 > now }).min(), background.count < limit {
            wakeScheduled = true
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(max(1, next.timeIntervalSinceNow)))
                await self?.wake()
            }
        }
    }

    private func wake() {
        wakeScheduled = false
        pump()
    }

    private func backgroundFinished(_ item: ImageItem, error: Error?) {
        background[item.name] = nil
        if let error {
            if !(error is CancellationError), (error as? URLError)?.code != .cancelled {
                let attempts = (failed[item.name]?.attempts ?? 0) + 1
                failed[item.name] = (attempts, Date().addingTimeInterval(min(600, 15 * pow(2, Double(attempts - 1)))))
                Log.images.info("Image failed (\(attempts)): \(error.localizedDescription, privacy: .public)")
            }
        } else {
            finished(item)
        }
        pump()
    }

    var state: [String: Int] {
        ["foreground": foreground.count, "background": background.count, "planned": plan.count, "done": done.count, "failed": failed.count, "active": active ? 1 : 0]
    }
}
