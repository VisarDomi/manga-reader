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
    private var preparing = false
    private var prepareAgain = false
    private var onHome = false
    private var status = ""
    private var sessionRefresh: Task<String, Error>?
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
    func setHome(_ home: Bool) { onHome = home }
    func snapshot() throws -> String {
        var payload = try object(JSONEncoder().encode(state))
        payload.removeValue(forKey: "tokens")
        payload["status"] = status
        payload["provider"] = ProviderConfiguration.current.rawValue
        payload["backupAvailable"] = backup.configured
        return try jsonText(payload)
    }
    func refreshCatalog() async throws {
        let items = try await source.catalog()
        guard !items.isEmpty else { throw ReaderError.message("The catalog is unavailable. Your saved library is still here.") }
        state.catalog = items
        try persist()
    }
    func chapters(_ slug: String) async throws -> [Chapter] {
        guard CachePolicy.validSlug(slug) else { throw ReaderError.message("Invalid series") }
        do {
            let result = try await source.chapters(slug)
            guard !result.isEmpty else { throw ReaderError.message("No chapters found") }
            try writeAtomically(JSONEncoder().encode(result), root.appendingPathComponent("lists/\(CachePolicy.key(slug, "list")).json"))
            return result
        } catch {
            if let data = try? Data(contentsOf: root.appendingPathComponent("lists/\(CachePolicy.key(slug, "list")).json")),
               let saved = try? JSONDecoder().decode([Chapter].self, from: data) { return saved }
            throw error
        }
    }
    func manifest(_ slug: String, _ chapter: String) async throws -> Manifest {
        guard CachePolicy.validSlug(slug), CachePolicy.validChapter(chapter) else { throw ReaderError.message("Invalid chapter") }
        let key = CachePolicy.key(slug, chapter)
        if let saved = manifests[key] { return saved }
        let file = root.appendingPathComponent("manifests/\(key).json")
        if let data = try? Data(contentsOf: file), let saved = try? JSONDecoder().decode(Manifest.self, from: data) {
            manifests[key] = saved; return saved
        }
        if let existing = manifestTasks[key] { return try await existing.value }
        let task = Task { [self] in
            var token = state.tokens["asura:access_token"]
            if source is any AsuraSource, token == nil, state.tokens["asura:refresh_token"] != nil { token = try await refreshSession() }
            do { return try await source.manifest(slug, chapter, token: token) }
            catch ReaderError.http(401) where source is any AsuraSource {
                return try await source.manifest(slug, chapter, token: await refreshSession())
            }
        }
        manifestTasks[key] = task
        do {
            let result = try await task.value
            try writeAtomically(JSONEncoder().encode(result), file)
            manifests[key] = result; manifestTasks[key] = nil
            return result
        } catch { manifestTasks[key] = nil; throw error }
    }
    func page(_ manifest: Manifest, _ index: Int, urgent: Bool) async throws -> (data: Data, mime: String) {
        guard manifest.pages.indices.contains(index) else { throw ReaderError.message("Invalid page") }
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
            let file = root.appendingPathComponent("covers/\(CachePolicy.key(series.slug, "cover"))")
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
        state.progress[key] = p
        state.history[key, default: [:]][p.chapter] = max(state.history[key]?[p.chapter] ?? -1, p.page)
        try persist()
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
        state = next
    }
    func saveView(_ data: Data) throws {
        let position = try JSONDecoder().decode(ViewPosition.self, from: data)
        guard position.path == "/" || position.path.hasPrefix("/reader/"), position.y.isFinite,
              position.fraction.isFinite else { throw ReaderError.message("Invalid view position") }
        state.view = position
        if position.path == "/" { state.home = position }
        try persist()
    }
    func prepareHome() async {
        guard onHome else { return }
        if preparing { prepareAgain = true; return }
        preparing = true
        defer {
            preparing = false; status = ""
            if prepareAgain { prepareAgain = false; Task { await self.prepareHome() } }
        }
        var keep = Set<String>()
        // Snapshot only drives enumeration. Recheck the live position after every await.
        for initial in state.progress.values.sorted(by: { $0.updatedAt > $1.updatedAt }) {
            guard onHome, !Task.isCancelled else { return }
            let identity = CachePolicy.identity(initial.slug)
            let slug = state.catalog.first(where: { $0.identity == identity })?.slug ?? initial.slug
            guard let list = try? await chapters(slug) else { return }
            guard onHome, !Task.isCancelled, state.progress[identity]?.chapter == initial.chapter else { return }
            for chapter in CachePolicy.window(current: initial.chapter, chapters: list) {
                keep.insert(CachePolicy.key(slug, chapter))
                guard onHome, !Task.isCancelled else { return }
                if let m = try? await manifest(slug, chapter) {
                    status = "Preparing \(m.title) · \(chapter)"
                    // Three transfers at a time leaves capacity for interactive cover/page requests.
                    for start in stride(from: 0, to: m.pages.count, by: 3) {
                        guard onHome, !Task.isCancelled else { return }
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
        }
        guard onHome, !Task.isCancelled else { return }
        try? pruneImages(keeping: keep)
    }
    func pruneImages(keeping keys: Set<String>) throws {
        let dir = root.appendingPathComponent("images")
        let dirs = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        for item in dirs where !keys.contains(item.lastPathComponent) {
            guard !transfers.keys.contains(where: { $0.hasPrefix(item.path + "/") }) else { continue }
            try FileManager.default.removeItem(at: item)
        }
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
            let m = try await manifest(slug, chapter)
            var result = try object(JSONEncoder().encode(m))
            if args["resume"] as? Bool == true, let p = state.progress[CachePolicy.identity(slug)], p.chapter == chapter {
                result["position"] = try object(JSONEncoder().encode(p))
            }
            return try jsonText(result)
        case "measure":
            let m = try await manifest(slug, args["chapter"] as? String ?? "")
            guard let index = args["index"] as? Int, m.pages.indices.contains(index) else { throw ReaderError.message("Invalid page") }
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
    func setTokens(_ tokens: [String: String]) throws {
        for (key, value) in tokens where ["asura:access_token", "asura:refresh_token"].contains(key) && !value.isEmpty { state.tokens[key] = value }
        try persist()
    }
    private func refreshSession() async throws -> String {
        if let sessionRefresh { return try await sessionRefresh.value }
        guard let refresh = state.tokens["asura:refresh_token"] else { throw ReaderError.message("Sign in to Asura again") }
        guard let source = source as? any AsuraSource else { throw ReaderError.message("This provider has no account session") }
        let task = Task { [source] in
            let json = try object(await source.request("/auth/refresh", method: "POST", body: jsonData(["refresh_token": refresh]), token: nil))
            guard let data = json["data"] as? [String: Any], let access = data["access_token"] as? String, !access.isEmpty else { throw ReaderError.message("Asura session expired") }
            var tokens = ["asura:access_token": access]
            if let rotated = data["refresh_token"] as? String { tokens["asura:refresh_token"] = rotated }
            try self.setTokens(tokens)
            return access
        }
        sessionRefresh = task
        defer { sessionRefresh = nil }
        return try await task.value
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
    }
}
