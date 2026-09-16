import Foundation
import ImageIO

actor ReaderStore {
    let root: URL
    let source: any ReaderSource
    private var state = AppState()
    private var loaded = false
    private var manifests: [String: Manifest] = [:]
    private var manifestTasks: [String: Task<Manifest, Error>] = [:]
    private var transfers: [String: Task<String, Error>] = [:]
    private var preparationTask: Task<Void, Never>?
    private var onHome = false
    private var preparationEnabled = false
    private var preparationRevision = 0
    private var retainedWindows: [String: Set<String>] = [:]
    private var chapterReaders: [String: Int] = [:]
    private var status = ""
    private var catalogPage: CatalogPage?
    private var catalogError: String?
    private let backup: PCBackup
    init(root: URL, source: any ReaderSource = ProviderConfiguration.current.makeSource(), backup: PCBackup = PCBackup()) {
        self.root = root; self.source = source; self.backup = backup
    }
    func load() throws {
        guard !loaded else { return }
        let file = root.appendingPathComponent("state.json")
        if FileManager.default.fileExists(atPath: file.path) { state = try JSONDecoder().decode(AppState.self, from: Data(contentsOf: file)) }
        loaded = true
    }
    func persist() throws { try writeAtomically(JSONEncoder().encode(state), root.appendingPathComponent("state.json")) }
    func lastView() -> ViewPosition { state.view }
    func setPreparationContext(home: Bool, active: Bool) {
        guard onHome != home || preparationEnabled != active else { return }
        onHome = home; preparationEnabled = active
        requestPreparation()
    }
    private func requestPreparation() {
        preparationRevision += 1
        guard preparationEnabled, preparationTask == nil else { return }
        preparationTask = Task { [self] in
            while preparationEnabled {
                let revision = preparationRevision
                await prepareDownloads()
                if preparationRevision == revision { break }
            }
            preparationTask = nil
        }
    }
    #if READER_TESTS
    func waitForPreparation() async { await preparationTask?.value }
    #endif
    func snapshot() throws -> String {
        var payload = try object(JSONEncoder().encode(state))
        payload.removeValue(forKey: "tokens")
        payload["status"] = status
        if let page = catalogPage {
            payload["catalogLoaded"] = page.series.count
            payload["catalogLoading"] = page.hasMore
            if let total = page.total { payload["catalogTotal"] = total }
        }
        if let catalogError { payload["catalogError"] = catalogError }
        payload["provider"] = ProviderConfiguration.current.rawValue
        payload["backupAvailable"] = backup.configured
        return try jsonText(payload)
    }
    func refreshCatalog(onUpdate: (@Sendable () async -> Void)? = nil) async throws {
        let cached = state.catalog
        catalogError = nil
        do {
            _ = try await source.catalog(onPage: { [self] page in
                try await publishCatalog(page, cached: cached)
                await onUpdate?()
            })
        } catch {
            if !Task.isCancelled {
                catalogError = error.localizedDescription
                await onUpdate?()
            }
            throw error
        }
    }
    private func publishCatalog(_ page: CatalogPage, cached: [Series]) throws {
        try Task.checkCancellation()
        catalogPage = page
        let fresh = Set(page.series.map(\.identity))
        // Keep cached, not-yet-refetched rows available for native Home restoration.
        // Completion removes absent rows; fresh data always owns order and metadata.
        state.catalog = page.series + (page.hasMore ? cached.filter { !fresh.contains($0.identity) } : [])
        try persist()
    }
    func chapters(_ slug: String) async throws -> [Chapter] {
        guard CachePolicy.validSlug(slug) else { throw ReaderError.message("Invalid series") }
        let result: [Chapter]
        do { result = try await source.chapters(slug) }
        catch {
            try Task.checkCancellation()
            if let data = try? Data(contentsOf: root.appendingPathComponent("lists/\(CachePolicy.key(slug, "list")).json")),
               let saved = try? JSONDecoder().decode([Chapter].self, from: data) { return saved }
            throw error
        }
        guard !result.isEmpty else { throw ReaderError.message("No chapters found") }
        guard Set(result.map(\.key)).count == result.count else { throw ReaderError.message("Chapter list repeats a chapter") }
        try writeAtomically(JSONEncoder().encode(result), root.appendingPathComponent("lists/\(CachePolicy.key(slug, "list")).json"))
        return result
    }

    func manifest(_ slug: String, _ chapter: String) async throws -> Manifest {
        guard CachePolicy.validSlug(slug), CachePolicy.validChapter(chapter) else { throw ReaderError.message("Invalid chapter") }
        let key = CachePolicy.key(slug, chapter)
        if let saved = manifests[key] { return saved.routed(to: slug) }
        let file = root.appendingPathComponent("manifests/\(key).json")
        if let data = try? Data(contentsOf: file), let saved = try? JSONDecoder().decode(Manifest.self, from: data) {
            manifests[key] = saved; return saved.routed(to: slug)
        }
        if let existing = manifestTasks[key] { return try await existing.value.routed(to: slug) }
        let task = Task { [source] in try await source.manifest(slug, chapter) }
        manifestTasks[key] = task
        do {
            let result = try await task.value
            try writeAtomically(JSONEncoder().encode(result), file)
            manifests[key] = result; manifestTasks[key] = nil
            return result.routed(to: slug)
        } catch { manifestTasks[key] = nil; throw error }
    }
    func page(_ manifest: Manifest, _ index: Int, urgent: Bool) async throws -> (data: Data, mime: String) {
        guard manifest.pages.indices.contains(index) else { throw ReaderError.message("Invalid page") }
        chapterReaders[manifest.key, default: 0] += 1
        defer { releaseChapter(manifest) }
        let file = root.appendingPathComponent("images/\(manifest.key)/\(index)")
        let mime = try await ensureImage(manifest.pages[index].url, file: file, urgent: urgent)
        measurePage(manifest, index, file: file)
        try Task.checkCancellation()
        return (try Data(contentsOf: file, options: .mappedIfSafe), mime)
    }
    private func measurePage(_ original: Manifest, _ index: Int, file: URL) {
        var m = manifests[original.key] ?? original
        guard m.pages.indices.contains(index), m.pages[index].width <= 0 || m.pages[index].height <= 0,
              let image = CGImageSourceCreateWithURL(file as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              let properties = CGImageSourceCopyPropertiesAtIndex(image, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Double,
              let height = properties[kCGImagePropertyPixelHeight] as? Double, width > 0, height > 0 else { return }
        m.pages[index].width = width; m.pages[index].height = height
        manifests[m.key] = m
        if let data = try? JSONEncoder().encode(m) { try? writeAtomically(data, root.appendingPathComponent("manifests/\(m.key).json")) }
    }
    private func ensureImage(_ url: String, file: URL, urgent: Bool) async throws -> String {
        if FileManager.default.fileExists(atPath: file.path), let mime = try? String(contentsOf: file.appendingPathExtension("mime"), encoding: .utf8) { return mime }
        if urgent { await source.prioritize(url) }
        if let transfer = transfers[file.path] { return try await transfer.value }
        let transfer = Task { [source] in try await source.image(url, to: file, urgent: urgent) }
        transfers[file.path] = transfer
        do { let mime = try await transfer.value; transfers[file.path] = nil; return mime }
        catch { transfers[file.path] = nil; throw error }
    }
    func localResource(_ url: URL) async throws -> (data: Data, mime: String) {
        try load()
        guard url.host == "app" else { throw ReaderError.message("Invalid local host") }
        let parts = url.pathComponents.filter { $0 != "/" }
        if parts.first == "page", parts.count == 4, let index = Int(parts[3]) {
            return try await page(manifest(parts[1], parts[2]), index, urgent: true)
        }
        if parts.first == "cover", parts.count == 2, let series = state.catalog.first(where: { $0.slug == parts[1] }) {
            let file = root.appendingPathComponent("covers/\(CachePolicy.key(series.slug, series.cover))")
            let mime = try await ensureImage(series.cover, file: file, urgent: true)
            return (try Data(contentsOf: file, options: .mappedIfSafe), mime)
        }
        let name = parts.last ?? "index.html"
        let allowed = ["app.js": "text/javascript", "reader-core.js": "text/javascript", "style.css": "text/css"]
        let filename = allowed[name] != nil ? name : "index.html"
        guard let file = Bundle.main.url(forResource: filename, withExtension: nil, subdirectory: "Web") else { throw ReaderError.message("Missing bundled reader") }
        return (try Data(contentsOf: file), allowed[name] ?? "text/html")
    }
    func savePosition(_ p: Position) throws {
        guard CachePolicy.validSlug(p.slug), CachePolicy.validChapter(p.chapter), p.total > 0,
              p.page >= 0, p.page < p.total, p.fraction.isFinite, (0...1).contains(p.fraction), p.updatedAt.isFinite else { throw ReaderError.message("Invalid reading position") }
        let key = CachePolicy.identity(p.slug)
        let changedChapter = state.progress[key]?.chapter != p.chapter
        state.progress[key] = p
        state.history[key, default: [:]][p.chapter] = max(state.history[key]?[p.chapter] ?? -1, p.page)
        try persist()
        if changedChapter { requestPreparation() }
    }
    func saveCheckpoint(_ data: Data) throws {
        struct Checkpoint: Decodable { let view: ViewPosition; let progress: Position? }
        let checkpoint = try JSONDecoder().decode(Checkpoint.self, from: data)
        let view = checkpoint.view
        guard view.path == "/" || view.path.hasPrefix("/reader/"), view.y.isFinite,
              view.fraction.isFinite else { throw ReaderError.message("Invalid view position") }
        var next = state
        if let p = checkpoint.progress {
            guard CachePolicy.validSlug(p.slug), CachePolicy.validChapter(p.chapter), p.total > 0,
                  p.page >= 0, p.page < p.total, p.fraction.isFinite, (0...1).contains(p.fraction), p.updatedAt.isFinite,
                  URL(string: view.path)?.path == "/reader/\(p.slug)/\(p.chapter)" else { throw ReaderError.message("Invalid reading checkpoint") }
            let key = CachePolicy.identity(p.slug)
            next.progress[key] = p
            next.history[key, default: [:]][p.chapter] = max(next.history[key]?[p.chapter] ?? -1, p.page)
        }
        next.view = view
        if view.path == "/" { next.home = view }
        // Like Gallery's view-save, one acknowledged native write owns the
        // complete resume state; suspension cannot split progress from screen.
        try writeAtomically(JSONEncoder().encode(next), root.appendingPathComponent("state.json"))
        let changedChapter = state.view.path != next.view.path || checkpoint.progress.map { state.progress[CachePolicy.identity($0.slug)]?.chapter != $0.chapter } == true
        state = next
        if changedChapter { requestPreparation() }
    }
    func saveView(_ data: Data) throws {
        let position = try JSONDecoder().decode(ViewPosition.self, from: data)
        guard position.path == "/" || position.path.hasPrefix("/reader/"), position.y.isFinite,
              position.fraction.isFinite else { throw ReaderError.message("Invalid view position") }
        state.view = position
        if position.path == "/" { state.home = position }
        try persist()
    }
    private func prepareDownloads() async {
        guard preparationEnabled else { return }
        defer { status = "" }
        let revision = preparationRevision
        func current() -> Bool { preparationEnabled && preparationRevision == revision && !Task.isCancelled }
        let readerSlug = URL(string: state.view.path)?.pathComponents.dropFirst(2).first
        let positions = state.progress.values.filter { position in
            onHome || readerSlug.map { CachePolicy.identity($0) == CachePolicy.identity(position.slug) } == true
        }.sorted { $0.updatedAt > $1.updatedAt }
        var keep = Set<String>(), allListsAvailable = true
        for initial in positions {
            guard current() else { return }
            let identity = CachePolicy.identity(initial.slug)
            let slug = state.catalog.first(where: { $0.identity == identity })?.slug ?? initial.slug
            guard let list = try? await chapters(slug) else { allListsAvailable = false; continue }
            guard current() else { return }
            let window = CachePolicy.window(current: initial.chapter, chapters: list)
            let keys = Set(window.map { CachePolicy.key(slug, $0) })
            retainedWindows[identity] = keys
            keep.formUnion(keys)
            // Move the disk window before fetching more. Other manga retain their own window.
            try? pruneDownloads(keeping: keys, series: slug, chapters: list)
            for chapter in window {
                guard current() else { return }
                if let m = try? await manifest(slug, chapter) {
                    guard current() else { return }
                    status = "Preparing \(m.title) · \(chapter)"
                    // Current, then next, then previous; leave capacity for visible images.
                    for start in stride(from: 0, to: m.pages.count, by: 3) {
                        guard current() else { return }
                        await withTaskGroup(of: Void.self) { group in
                            for index in start..<min(start + 3, m.pages.count) {
                                group.addTask { [self] in
                                    let file = root.appendingPathComponent("images/\(m.key)/\(index)")
                                    if (try? await ensureImage(m.pages[index].url, file: file, urgent: false)) != nil { await measurePage(m, index, file: file) }
                                }
                            }
                        }
                    }
                }
            }
            guard current() else { return }
            try? pruneDownloads(keeping: keys, series: slug, chapters: list)
        }
        guard current(), onHome, allListsAvailable else { return }
        try? pruneDownloads(keeping: keep)
    }
    func pruneDownloads(keeping keys: Set<String>, series: String? = nil, chapters: [Chapter] = []) throws {
        let fm = FileManager.default
        let imageDir = root.appendingPathComponent("images"), manifestDir = root.appendingPathComponent("manifests")
        let files = (try? fm.contentsOfDirectory(at: manifestDir, includingPropertiesForKeys: nil)) ?? []
        var eligible = Set(chapters.map { CachePolicy.key(series ?? "", $0.key) })
        if let series {
            for file in files {
                if let data = try? Data(contentsOf: file), let m = try? JSONDecoder().decode(Manifest.self, from: data),
                   CachePolicy.identity(m.slug) == CachePolicy.identity(series) { eligible.insert(m.key) }
            }
        }
        let images = (try? fm.contentsOfDirectory(at: imageDir, includingPropertiesForKeys: nil)) ?? []
        let candidates = Set(images.map(\.lastPathComponent)).union(files.map { $0.deletingPathExtension().lastPathComponent }).union(manifests.keys)
        for key in candidates where !keys.contains(key) && (series == nil || eligible.contains(key)) {
            try removeDownload(key)
        }
    }
    private func removeDownload(_ key: String) throws {
        let fm = FileManager.default, dir = root.appendingPathComponent("images/\(key)")
        guard chapterReaders[key, default: 0] == 0, manifestTasks[key] == nil,
              !transfers.keys.contains(where: { $0.hasPrefix(dir.path + "/") }) else { return }
        if fm.fileExists(atPath: dir.path) { try fm.removeItem(at: dir) }
        let file = root.appendingPathComponent("manifests/\(key).json")
        if fm.fileExists(atPath: file.path) { try fm.removeItem(at: file) }
        manifests.removeValue(forKey: key)
    }
    private func releaseChapter(_ m: Manifest) {
        chapterReaders[m.key, default: 1] -= 1
        if chapterReaders[m.key] == 0 { chapterReaders.removeValue(forKey: m.key) }
        if let keep = retainedWindows[CachePolicy.identity(m.slug)], !keep.contains(m.key) { try? removeDownload(m.key) }
    }
    func webReply(_ command: String, data: Data) async throws -> String {
        try load()
        let args = try object(data)
        let slug = args["slug"] as? String ?? ""
        switch command {
        case "snapshot": return try snapshot()
        case "chapters": return String(decoding: try JSONEncoder().encode(await chapters(slug)), as: UTF8.self)
        case "open":
            let chapter = args["chapter"] as? String ?? ""
            let m: Manifest
            do { m = try await manifest(slug, chapter) }
            catch ReaderError.unavailable where args["append"] as? Bool == true { return try jsonText(["unavailable": true]) }
            catch ReaderError.http(404) where args["append"] as? Bool == true { return try jsonText(["unavailable": true]) }
            var result = try object(JSONEncoder().encode(m))
            if args["resume"] as? Bool == true, let p = state.progress[CachePolicy.identity(slug)], p.chapter == chapter {
                result["position"] = try object(JSONEncoder().encode(p))
            }
            return try jsonText(result)
        case "measure":
            let m = try await manifest(slug, args["chapter"] as? String ?? "")
            guard let index = args["index"] as? Int, m.pages.indices.contains(index) else { throw ReaderError.message("Invalid page") }
            chapterReaders[m.key, default: 0] += 1
            defer { releaseChapter(m) }
            let file = root.appendingPathComponent("images/\(m.key)/\(index)")
            _ = try await ensureImage(m.pages[index].url, file: file, urgent: true)
            measurePage(m, index, file: file)
            let size = manifests[m.key]?.pages[index] ?? m.pages[index]
            return try jsonText(["width": size.width, "height": size.height])
        case "view-save": try saveCheckpoint(data)
        case "position": try savePosition(JSONDecoder().decode(Position.self, from: data))
        case "view": try saveView(data)
        case "pc-available": return await backup.available() ? "true" : "false"
        case "pc-save": try await backup.save(BackupCodec.encode(state))
        case "pc-load":
            try importBackup(await backup.load())
            return try snapshot()
        default: throw ReaderError.message("Unknown reader request")
        }
        return "{}"
    }
    func importBackup(_ raw: Data) throws {
        let incoming = try BackupCodec.decode(raw)
        // Load is an explicit replacement, irrespective of timestamps.
        var replacement = state
        replacement.progress = incoming.progress
        replacement.history = incoming.history
        replacement.view = ViewPosition()
        try writeAtomically(JSONEncoder().encode(replacement), root.appendingPathComponent("state.json"))
        state = replacement
        requestPreparation()
    }
}
