import Foundation
import ImageIO
import KitCore
import KitNet

// MARK: - Site work (chapters, lists, catalog pages): what the screen waits for first

// Up to six pieces of work for the screen at once. Background work (two at a time) waits while
// any of those runs, so a chapter being opened never shares the site with the plan's lists or
// the catalog. Work the screen asks for while it waits or runs becomes urgent (Urgency, read
// by each of its requests through SiteClient).
actor MetadataQueue {
    private struct Waiter { let id: UUID; let key: String?; let urgency: Urgency; let preparation: Bool; let continuation: CheckedContinuation<Bool, Never> }
    private var running: [UUID: (key: String?, urgency: Urgency)] = [:]
    private var waiting: [Waiter] = []
    private var readerBusy = false
    private var readerRevision = -1

    func run<T: Sendable>(urgent: Bool, key: String?, preparation: Bool = false, _ work: @Sendable () async throws -> T) async throws -> T {
        let id = UUID(), urgency = Urgency(urgent)
        guard await acquire(id: id, key: key, urgency: urgency, preparation: preparation) else { throw CancellationError() }
        defer { release(id) }
        return try await SiteClient.$urgency.withValue(urgency) { try await work() }
    }

    func setReaderBusy(_ value: Bool, revision: Int? = nil) {
        if let revision {
            guard revision >= readerRevision else { return }
            readerRevision = revision
        }
        readerBusy = value; pump()
    }

    func prioritize(_ key: String) {
        for item in running.values where item.key == key { item.urgency.raise() }
        for waiter in waiting where waiter.key == key { waiter.urgency.raise() }
        pump()
    }

    private func acquire(id: UUID, key: String?, urgency: Urgency, preparation: Bool) async -> Bool {
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                waiting.append(Waiter(id: id, key: key, urgency: urgency, preparation: preparation, continuation: continuation))
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
                guard !readerBusy, running.count < 2, !running.values.contains(where: { $0.urgency.value }) else { return }
                index = waiting.firstIndex(where: { $0.preparation }) ?? 0
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
    private var chapterListeners: [@Sendable (String, String) -> Void] = []

    init(provider: any MangaProvider, files: ChapterFiles) {
        self.provider = provider
        self.files = files
    }

    func onListChange(_ listener: @escaping @Sendable (String) -> Void) { listeners.append(listener) }
    func onChapterChange(_ listener: @escaping @Sendable (String, String) -> Void) { chapterListeners.append(listener) }
    func setReaderBusy(_ value: Bool, revision: Int? = nil) async { await queue.setReaderBusy(value, revision: revision) }
    func prioritize(_ keys: [String]) async { for key in keys { await queue.prioritize(key) } }

    // A chapter's pages (nil: unavailable). The saved file answers at once; otherwise one
    // request per chapter, ahead of background work when `urgent`.
    func chapter(series: String, slug: String, chapterId: String, urgent: Bool) async throws -> ChapterData? {
        if let saved = await files.chapter(series, chapterId) { return saved }
        let key = FileKey.chapter(series, chapterId)
        if urgent { await queue.prioritize(key) }
        if let task = chapterTasks[key] { return try await task.value }
        let task = Task { [provider, queue, files] () throws -> ChapterData? in
            let data = try await queue.run(urgent: urgent, key: key, preparation: true) { try await provider.chapter(slug, chapterId) }
            if let data { await files.save(data, series: series) }
            return data
        }
        chapterTasks[key] = task
        defer { chapterTasks[key] = nil }
        let result = try await task.value
        if result != nil { for listener in chapterListeners { listener(series, chapterId) } }
        return result
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
        let task = Task { [provider, queue] in try await queue.run(urgent: urgent, key: key, preparation: true) { try await provider.chaptersNewestFirst(slug) } }
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
            if let list {
                if withNewerChapters(list, row) != list { notify(series) }
                else if let newest = row.first, !list.contains(newest) {
                    // A short Home row may not prove adjacency. Refresh its list now
                    // instead of waiting 15 minutes or guessing and skipping chapters.
                    listChecked[series] = .distantPast
                    notify(series)
                }
            }
        }
    }

    private func notify(_ series: String) { for listener in listeners { listener(series) } }
}

// MARK: - Image files (images/ and covers/, <sha256(url)> plus a .mime marker of completion)

struct ImageItem: Hashable, Sendable {
    let url: String
    let cover: Bool
    let name: String
    init(url: String, cover: Bool) {
        self.url = url; self.cover = cover
        name = (cover ? "covers/" : "images/") + FileKey.sha256(url)
    }
}

// The decoder's canvas, not website attributes or a downsampled display bitmap.
enum ImageDimensions {
    static func read(_ file: URL) -> CGSize? {
        if let values = try? DurableFile.readJSON([Double].self, from: file.appendingPathExtension("dimensions")),
           values.count == 2, values.allSatisfy({ $0.isFinite && $0 > 0 }) {
            return CGSize(width: values[0], height: values[1])
        }
        return measure(file)
    }

    static func measure(_ file: URL) -> CGSize? {
        autoreleasepool {
            let options = [kCGImageSourceShouldCache: false] as CFDictionary
            guard let source = CGImageSourceCreateWithURL(file as CFURL, options),
                  let image = CGImageSourceCreateImageAtIndex(source, 0, options),
                  CGImageSourceGetStatusAtIndex(source, 0) == .statusComplete,
                  image.width > 0, image.height > 0 else { return nil }
            let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
            let orientation = (properties?[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
            let size = (5...8).contains(orientation)
                ? CGSize(width: image.height, height: image.width)
                : CGSize(width: image.width, height: image.height)
            try? DurableFile.writeJSON([Double(size.width), Double(size.height)], to: file.appendingPathExtension("dimensions"))
            return size
        }
    }
}

// The only owner of image bytes. Pages on screen load first (shared per image, dropped when
// nobody waits); then the reader's current/next pair, covers and touched series' pairs.
// Retired downloaded pages expire after 24 hours; covers are kept permanently.
actor ImageFiles {
    private struct Transfer { let id = UUID(); let task: Task<URL, Error>; var callers: Set<UUID> = [] }
    let root: URL
    private let http: SiteClient
    private let referer: String
    private var foreground: [String: Transfer] = [:]
    private var background: [String: Task<Void, Never>] = [:]
    private var backgroundUrgency: [String: Urgency] = [:]
    private var plan: [ImageItem] = []
    private var itemsByName: [String: ImageItem] = [:]
    private var planCursor = 0
    private var readerPlan: [ImageItem] = []
    private var done = Set<String>()
    private var absent = Set<String>()
    private var fileChecks = 0
    private var failed: [String: (attempts: Int, retryAt: Date)] = [:]
    private var retained: Set<String>?
    private var scanned = false
    private var retention: PageRetention
    private var retentionWake: Task<Void, Never>?
    private var retentionWakeAt: Date?
    private var existingPages = Set<String>()
    private(set) var removedPageFiles = 0
    private(set) var removedPageBytes: Int64 = 0
    private var active = true
    private var wakeScheduled = false
    private var observers: [@Sendable (ImageItem) -> Void] = []
    private var coverObservers: [@Sendable (ImageItem) -> Void] = []
    private var rechecks: [ImageItem] = []
    private var recheckRunning = false
    private var readerNames: Set<String>?
    private var readerMetadataPending = false
    private var reportedReaderBusy = false
    private var readerRevision = 0
    private var readerObservers: [@Sendable (Bool, Int) -> Void] = []
    private var lastAsked: [String: Date] = [:]

    init(root: URL, http: HTTPClient, referer: String, limiter: RequestLimiter? = nil) {
        self.root = root
        self.http = SiteClient(http: http, limiter: limiter ?? RequestLimiter(.media))
        self.referer = referer
        retention = (try? DurableFile.readJSON(PageRetention.self, from: root.appendingPathComponent("page-retention.json"))) ?? PageRetention()
    }

    nonisolated func url(_ item: ImageItem) -> URL { root.appendingPathComponent(item.name) }

    // The file when it is already complete on the phone (read without waiting for the actor:
    // a relaunch decodes it for the first frame).
    nonisolated func localFile(_ item: ImageItem) -> URL? {
        let file = url(item)
        guard FileManager.default.fileExists(atPath: file.appendingPathExtension("mime").path), (DurableFile.size(file) ?? 0) > 0 else { return nil }
        return file
    }

    private func complete(_ item: ImageItem) -> Bool { complete(item.name) }

    private func complete(_ name: String) -> Bool {
        if done.contains(name) { return true }
        if absent.contains(name) { return false }
        fileChecks += 1
        let file = root.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: file.appendingPathExtension("mime").path), (DurableFile.size(file) ?? 0) > 0 else {
            absent.insert(name); return false
        }
        done.insert(name)
        return true
    }

    func isComplete(_ item: ImageItem) -> Bool { complete(item) }

    // Which of these files are complete.
    func completed(_ names: [String]) -> [String] {
        names.filter { complete($0) }
    }

    func onFinished(_ observer: @escaping @Sendable (ImageItem) -> Void) { observers.append(observer) }
    func onReaderWorkChanged(_ observer: @escaping @Sendable (Bool, Int) -> Void) {
        readerObservers.append(observer)
        observer(readerWorkPending(), readerRevision)
    }

    // An image someone is looking at.
    func file(_ item: ImageItem) async throws -> URL {
        if complete(item) { return url(item) }
        try Task.checkCancellation()
        // Promote the existing work by awaiting it; never throw away bytes already arriving.
        if let task = background[item.name] {
            backgroundUrgency[item.name]?.raise(to: 2)
            await task.value
            try Task.checkCancellation()
            if complete(item) { return url(item) }
        }
        if foreground[item.name] == nil {
            foreground[item.name] = Transfer(task: Task { [http, referer, root] in
                try await SiteClient.$urgency.withValue(Urgency(true, priority: 2)) {
                    try await Self.download(item, http: http, referer: referer, root: root, priority: URLSessionTask.highPriority)
                }
            })
        }
        let caller = UUID()
        foreground[item.name]!.callers.insert(caller)
        let transfer = foreground[item.name]!
        defer {
            if foreground[item.name]?.id == transfer.id {
                foreground[item.name] = nil
                if !done.contains(item.name) { planCursor = 0 }
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
        planCursor = 0
        pump()
    }

    private static func download(_ item: ImageItem, http: SiteClient, referer: String, root: URL, priority: Float) async throws -> URL {
        guard let source = URL(string: item.url), source.scheme == "https" else { throw ProviderError.invalid("Invalid image URL") }
        let file = root.appendingPathComponent(item.name)
        let response = try await http.download(HTTPRequest(source, referer: referer, priority: priority), to: file) { response in
            guard response.statusCode == 200, response.mimeType?.hasPrefix("image/") == true else { throw URLError(.badServerResponse) }
        }
        guard ImageDimensions.measure(file) != nil else {
            try? FileManager.default.removeItem(at: file)
            throw URLError(.cannotDecodeContentData)
        }
        if item.cover { saveCheck(for: file, response: response) }
        try DurableFile.write(Data((response.mimeType ?? "image/jpeg").utf8), to: file.appendingPathExtension("mime"))
        return file
    }

    // MARK: covers kept up to date

    // A cover's validators from the site (ETag, Last-Modified) and when it was last asked
    // whether it changed (<cover>.check beside the file).
    struct Check: Codable {
        var etag: String?
        var lastModified: String?
        var checkedAt: Date
    }

    static let recheckAfter: TimeInterval = 6 * 3600

    nonisolated static func saveCheck(for file: URL, response: HTTPURLResponse, known: Check? = nil) {
        let check = Check(etag: response.value(forHTTPHeaderField: "ETag") ?? known?.etag,
                          lastModified: response.value(forHTTPHeaderField: "Last-Modified") ?? known?.lastModified, checkedAt: Date())
        try? DurableFile.writeJSON(check, to: file.appendingPathExtension("check"))
    }

    func onCoverChanged(_ observer: @escaping @Sendable (ImageItem) -> Void) { coverObservers.append(observer) }

    // A cover on screen: every cover stays on the phone, and one not asked about for six hours
    // is asked about again, lazily, one at a time and behind everything else. The request is
    // conditional (all six sites answer 304 with no bytes when nothing changed); only new bytes
    // replace the file, and the screen is told.
    func recheck(_ item: ImageItem) {
        guard item.cover, lastAsked[item.name].map({ Date().timeIntervalSince($0) > Self.recheckAfter }) ?? true, complete(item) else { return }
        lastAsked[item.name] = Date()
        if let check = try? DurableFile.readJSON(Check.self, from: url(item).appendingPathExtension("check")),
           Date().timeIntervalSince(check.checkedAt) < Self.recheckAfter { return }
        rechecks.append(item)
        pumpRechecks()
    }

    private func pumpRechecks() {
        guard active, !readerWorkPending(), !recheckRunning, !rechecks.isEmpty else { return }
        recheckRunning = true
        let item = rechecks.removeFirst()
        Task { [http, referer, root] in
            let changed = await Self.recheckNow(item, http: http, referer: referer, root: root)
            self.recheckFinished(item, changed: changed)
        }
    }

    private func recheckFinished(_ item: ImageItem, changed: Bool) {
        recheckRunning = false
        if changed { for observer in coverObservers { observer(item) } }
        pumpRechecks()
    }

    private static func recheckNow(_ item: ImageItem, http: SiteClient, referer: String, root: URL) async -> Bool {
        guard let source = URL(string: item.url), source.scheme == "https" else { return false }
        let file = root.appendingPathComponent(item.name)
        let known = try? DurableFile.readJSON(Check.self, from: file.appendingPathExtension("check"))
        var headers: [String: String] = [:]
        if let etag = known?.etag { headers["If-None-Match"] = etag }
        // A cover saved before validators were kept: changed since this phone downloaded it?
        let written = (try? FileManager.default.attributesOfItem(atPath: file.path))?[.modificationDate] as? Date
        if let since = known?.lastModified ?? written.map(httpDate) { headers["If-Modified-Since"] = since }
        guard let response = try? await http.send(HTTPRequest(source, headers: headers, referer: referer, retry: .never,
                                                               priority: URLSessionTask.lowPriority, accept: [304])) else { return false }
        if response.status == 304 {
            saveCheck(for: file, response: response.response, known: known)
            return false
        }
        guard response.status == 200, response.response.mimeType?.hasPrefix("image/") == true, !response.data.isEmpty else { return false }
        let changed = (try? Data(contentsOf: file)) != response.data
        if changed {
            do {
                try DurableFile.write(response.data, to: file)
                try DurableFile.write(Data((response.response.mimeType ?? "image/jpeg").utf8), to: file.appendingPathExtension("mime"))
            } catch { return false }
        }
        saveCheck(for: file, response: response.response)
        return changed
    }

    nonisolated static func httpDate(_ date: Date) -> String {
        let format = DateFormatter()
        format.locale = Locale(identifier: "en_US_POSIX")
        format.timeZone = TimeZone(identifier: "GMT")
        format.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        return format.string(from: date)
    }

    private func finished(_ item: ImageItem) {
        if !item.cover {
            existingPages.insert(item.name)
            if retained != nil && !retention.keeps(item.name, now: Date()) { remove(item.name); return }
        }
        let newlyComplete = done.insert(item.name).inserted
        absent.remove(item.name)
        failed[item.name] = nil
        guard newlyComplete else { return }
        for observer in observers { observer(item) }
    }

    // What to download, in order (replacing the previous plan).
    func prioritizeReader(_ items: [ImageItem], awaitingMetadata: Bool) {
        readerPlan = items
        readerNames = Set(items.map(\.name))
        readerMetadataPending = awaitingMetadata
        if retained != nil {
            let required = retention.required.union(readerNames ?? [])
            if required != retention.required {
                retention.required = required; retained = required
                for name in required { retention.expires[name] = nil }
                try? DurableFile.writeJSON(retention, to: root.appendingPathComponent("page-retention.json"))
            }
        }
        for item in items { backgroundUrgency[item.name]?.raise() }
        pump()
    }

    func setPlan(_ items: [ImageItem], readerNames: Set<String>? = nil, awaitingReaderMetadata: Bool = false, preservingReader: Bool = false) {
        plan = items
        planCursor = 0
        itemsByName = Dictionary(items.map { ($0.name, $0) }, uniquingKeysWith: { first, _ in first })
        if !preservingReader {
            self.readerNames = readerNames
            readerPlan = readerNames.map { names in items.filter { names.contains($0.name) } } ?? []
            readerMetadataPending = awaitingReaderMetadata
        }
        let wanted = Set(itemsByName.keys).union(self.readerNames ?? [])
        for (name, task) in background where !wanted.contains(name) { task.cancel() }
        pump()
    }

    // Current/next pages stay; retired downloaded pages get a durable 24-hour grace.
    func setRetained(_ names: Set<String>, migrationGrace: Set<String> = [], now: Date = Date()) async {
        if !scanned {
            let folder = root.appendingPathComponent("images")
            let entries = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
            for entry in entries where !entry.hasPrefix(".") {
                let stem = entry.hasSuffix(".mime") ? String(entry.dropLast(5)) : entry.hasSuffix(".dimensions") ? String(entry.dropLast(11)) : entry
                existingPages.insert("images/" + stem)
            }
            scanned = true
        }
        retained = names
        let before = retention
        let removed = retention.reconcile(required: names, existing: existingPages, migrationGrace: migrationGrace, now: now)
        // Publish the allowed state before deleting, so an interrupted cleanup resumes.
        if !before.migrationComplete || before.required != retention.required || before.expires != retention.expires || !removed.isEmpty {
            do { try DurableFile.writeJSON(retention, to: root.appendingPathComponent("page-retention.json")) }
            catch {
                retention = before; retained = before.required
                Log.store.error("Page retention: \(error.localizedDescription, privacy: .public)")
                return
            }
        }
        for name in removed {
            background[name]?.cancel()
            if foreground[name] == nil && !retention.keeps(name, now: now) { remove(name) }
            await Task.yield()
        }
        scheduleRetention(now: now)
    }

    func needsRetentionMigration() -> Bool { !retention.migrationComplete }

    var storageReport: [String: Int64] {
        ["removedFiles": Int64(removedPageFiles), "removedBytes": removedPageBytes,
         "remainingPageFiles": Int64(existingPages.count), "currentNextFiles": Int64(retention.required.count),
         "expiringFiles": Int64(retention.expires.count)]
    }

    private func scheduleRetention(now: Date) {
        guard let next = retention.expires.values.min() else {
            retentionWake?.cancel(); retentionWake = nil; retentionWakeAt = nil; return
        }
        guard retentionWakeAt != next else { return }
        retentionWake?.cancel(); retentionWakeAt = next
        retentionWake = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(max(1, next.timeIntervalSince(now)))) } catch { return }
            await self?.evictExpired()
        }
    }

    private func evictExpired() async {
        retentionWakeAt = nil
        await setRetained(retention.required)
    }

    private func remove(_ name: String) {
        guard name.hasPrefix("images/") else { return }
        let file = root.appendingPathComponent(name)
        let size = DurableFile.size(file) ?? 0
        // Completion marker first: a power cut cannot leave a valid-looking missing file.
        try? FileManager.default.removeItem(at: file.appendingPathExtension("mime"))
        try? FileManager.default.removeItem(at: file)
        try? FileManager.default.removeItem(at: file.appendingPathExtension("dimensions"))
        guard !FileManager.default.fileExists(atPath: file.path) else { return }
        existingPages.remove(name)
        if size > 0 { removedPageFiles += 1; removedPageBytes += size }
        done.remove(name)
        absent.insert(name)
    }

    // Paused while the app is away (the background session carries on).
    func setActive(_ value: Bool) {
        active = value
        if value { planCursor = 0 }
        if !value { for task in background.values { task.cancel() } }
        pump()
        pumpRechecks()
    }

    // The unfinished planned work, in order.
    func unfinished(limit: Int) -> [ImageItem] {
        var result: [ImageItem] = []
        var seen = Set<String>()
        for item in [readerPlan, plan].joined() where seen.insert(item.name).inserted && !complete(item) {
            result.append(item)
            if result.count == limit { break }
        }
        return result
    }

    func committed(_ name: String) {
        if name.hasPrefix("images/") {
            existingPages.insert(name)
            if retained != nil && !retention.keeps(name, now: Date()) { remove(name); pump(); return }
        }
        guard let item = itemsByName[name] ?? readerPlan.first(where: { $0.name == name }) else {
            done.insert(name); absent.remove(name); pump(); return
        }
        guard ImageDimensions.read(url(item)) != nil else { remove(name); pump(); return }
        finished(item)
        pump()
    }

    func invalidate(_ item: ImageItem) { invalidate(item.name) }
    func invalidate(_ name: String) { remove(name); planCursor = 0; pump() }

    func readerWorkPending() -> Bool {
        guard let names = readerNames else { return false }
        return readerMetadataPending || names.contains { !complete($0) }
    }

    private func pump() {
        let restricted = readerWorkPending()
        if restricted != reportedReaderBusy {
            reportedReaderBusy = restricted; readerRevision += 1
            for observer in readerObservers { observer(restricted, readerRevision) }
        }
        guard active else { return }
        let limit = foreground.isEmpty ? 3 : 1
        guard background.count < limit else { return }
        let now = Date()
        func start(_ item: ImageItem) {
            if background[item.name] != nil || foreground[item.name] != nil || complete(item) { return }
            if let failure = failed[item.name], failure.retryAt > now { return }
            let urgency = Urgency(readerNames?.contains(item.name) == true)
            backgroundUrgency[item.name] = urgency
            background[item.name] = Task(priority: .utility) { [http, referer, root] in
                let outcome: Error?
                do {
                    _ = try await SiteClient.$urgency.withValue(urgency) {
                        try await Self.download(item, http: http, referer: referer, root: root,
                                                priority: item.cover ? URLSessionTask.lowPriority : URLSessionTask.defaultPriority)
                    }
                    outcome = nil
                } catch { outcome = error }
                self.backgroundFinished(item, error: outcome)
            }
        }
        for item in readerPlan {
            guard background.count < limit else { return }
            start(item)
        }
        while !restricted && planCursor < plan.count {
            guard background.count < limit else { return }
            let item = plan[planCursor]; planCursor += 1
            start(item)
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
        planCursor = 0
        pump()
    }

    private func backgroundFinished(_ item: ImageItem, error: Error?) {
        background[item.name] = nil
        backgroundUrgency[item.name] = nil
        if let error {
            planCursor = 0
            if !(error is CancellationError), (error as? URLError)?.code != .cancelled {
                let attempts = (failed[item.name]?.attempts ?? 0) + 1
                failed[item.name] = (attempts, Date().addingTimeInterval(min(600, 15 * pow(2, Double(attempts - 1)))))
                Log.images.info("Image failed (\(attempts)): \(error.localizedDescription, privacy: .public)")
            }
        } else {
            if !item.cover {
                existingPages.insert(item.name)
                if retained != nil && !retention.keeps(item.name, now: Date()) { remove(item.name); pump(); return }
            }
            finished(item)
        }
        pump()
    }

    var state: [String: Int] {
        ["foreground": foreground.count, "background": background.count, "planned": plan.count, "done": done.count, "failed": failed.count, "active": active ? 1 : 0, "fileChecks": fileChecks, "planCursor": planCursor]
    }
}
