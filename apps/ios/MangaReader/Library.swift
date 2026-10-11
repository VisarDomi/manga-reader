import Foundation
import ImageIO
import KitCore
import KitLifecycle
import KitNet

extension Notification.Name {
    static let catalogChanged = Notification.Name("MangaCatalogChanged")
}

// The app's model: the catalog (kept on the phone, refreshed in the background), reading
// progress, saved chapters, and what downloads. Every started series keeps its current and
// next chapter on the phone; a new chapter downloads as soon as the catalog or a chapter list
// shows it. The chapter being read comes first, then the most recently read series, then
// the catalog's covers.
@MainActor
final class Library {
    let provider: any MangaProvider
    let state: ReadingState
    let chapters: ChapterSource
    let images: ImageFiles
    let root: URL
    private(set) var catalog: Catalog
    private(set) var catalogError: String?
    private(set) var refreshing = false
    private(set) var routes: [String: String]
    private let catalogWriter: BackgroundWriter
    private let routesWriter: BackgroundWriter
    private let transfers: BackgroundTransfers
    private var readers: [ObjectIdentifier: Reading] = [:]
    private var focus: ObjectIdentifier?
    private var planScheduled = false
    private var preparing = Set<String>()
    private var unavailable: [String: Date] = [:]
    private var lastRefresh: Date?
    // Pages without a known size, by image file: where they belong.
    private var unsized: [String: (series: String, chapter: String, index: Int)] = [:]
    private var sizes: [String: (series: String, chapter: String, sizes: [Int: CGSize])] = [:]
    private var sizesScheduled = false

    // What a reader screen shows: its series, the chapters it holds and where it is.
    struct Reading {
        var series: String
        var slug: String
        var chapters: [String]
        var chapter: String
        var page: Int
    }

    init(provider: any MangaProvider, root: URL, bundleID: String) {
        self.provider = provider
        self.root = root
        state = ReadingState(directory: root, provider: provider.key)
        chapters = ChapterSource(provider: provider, files: ChapterFiles(directory: root))
        let referer = provider.origin.absoluteString + "/"
        images = ImageFiles(root: root, http: HTTPClient(.init(connectionsPerHost: 6, requestTimeout: 20, resourceTimeout: 90, waitsForConnectivity: true)), referer: referer)
        catalogWriter = BackgroundWriter(url: root.appendingPathComponent("catalog.json"), label: "manga-catalog")
        routesWriter = BackgroundWriter(url: root.appendingPathComponent("routes.json"), label: "manga-routes")
        catalog = (try? DurableFile.readJSON(Catalog.self, from: catalogWriter.url)) ?? Catalog()
        routes = (try? DurableFile.readJSON([String: String].self, from: routesWriter.url)) ?? [:]
        let images = images
        transfers = BackgroundTransfers(identifier: bundleID + ".images", root: root, connections: 4,
                                        accept: { $0.statusCode == 200 && $0.mimeType?.hasPrefix("image/") == true },
                                        committed: { item, response in
            let file = root.appendingPathComponent(item.file)
            try? DurableFile.write(Data((response.mimeType ?? "image/jpeg").utf8), to: file.appendingPathExtension("mime"))
            Task { await images.committed(item.file) }
        })
        Task { await chapters.onListChange { _ in Task { @MainActor [weak self] in self?.planSoon() } } }
        Task { await images.onFinished { item in Task { @MainActor [weak self] in self?.finished(item) } } }
        Task { await chapters.setRows(rows(catalog.series)) }
        NotificationCenter.default.addObserver(forName: .progressChanged, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.planSoon() }
        }
    }

    func identity(_ series: HomeSeries) -> String { series.historyId ?? provider.identity(series.slug) }

    // The series' current URL slug (Asura's rotates).
    func slug(_ series: String) -> String { routes[series] ?? series }

    func handleEvents(_ completion: @escaping () -> Void) { transfers.handleEvents(completion) }

    // MARK: catalog

    // Pages from the newest; a partial refresh stops at the first page that changes nothing.
    func refreshCatalog(full requested: Bool = false) {
        guard !refreshing else { return }
        let full = requested || !catalog.complete || catalog.series.isEmpty || (catalog.fetchedAt.map { Date().timeIntervalSince($0) > 86_400 } ?? true)
        refreshing = true
        catalogError = nil
        lastRefresh = Date()
        NotificationCenter.default.post(name: .catalogChanged, object: nil)
        Task {
            do { try await walk(full: full) }
            catch {
                catalogError = error.localizedDescription
                Log.network.error("Catalog: \(error.localizedDescription, privacy: .public)")
            }
            refreshing = false
            NotificationCenter.default.post(name: .catalogChanged, object: nil)
        }
    }

    // iOS's occasional background refresh: the newest catalog pages, then the chapters they
    // reveal, handed to the background session (which carries on outside the app).
    func backgroundRefresh() async {
        if !refreshing {
            refreshing = true
            lastRefresh = Date()
            do { try await walk(full: false) } catch { Log.network.info("Background catalog: \(error.localizedDescription, privacy: .public)") }
            refreshing = false
        }
        await plan()
        for _ in 0..<20 where !preparing.isEmpty && !Task.isCancelled { try? await Task.sleep(for: .seconds(1)) }
        await plan()
        await handOffNow()
    }

    // Back on screen after a while, or when the catalog was never complete.
    func refreshIfStale() {
        if lastRefresh.map({ Date().timeIntervalSince($0) > 300 }) ?? true { refreshCatalog() }
    }

    private func walk(full: Bool) async throws {
        let base = catalog.series
        let known = Dictionary(base.map { (identity($0), $0) }, uniquingKeysWith: { first, _ in first })
        let provider = provider
        var fresh: [HomeSeries] = []
        var pending: [String: Task<HomePage, Error>] = [:]
        var seen = Set<String>()
        defer { pending.values.forEach { $0.cancel() } }
        var page = try await Task { try await provider.home(nil) }.value
        while true {
            try Task.checkCancellation()
            fresh += page.series
            let unchanged = !page.series.isEmpty && page.series.allSatisfy { known[identity($0)] == $0 }
            apply(Catalog.merged(base, fresh: fresh) { self.identity($0) }, total: page.total, complete: false)
            guard let next = page.nextCursor, full || !unchanged else { break }
            guard seen.insert(next).inserted else { throw ProviderError.invalid("The site repeated catalog page \(next)") }
            if pending[next] == nil { pending[next] = Task { try await provider.home(next) } }
            // A full walk keeps up to three pages in flight.
            for cursor in page.prefetchCursors where full && pending.count < 3 && !seen.contains(cursor) && pending[cursor] == nil {
                pending[cursor] = Task { try await provider.home(cursor) }
            }
            page = try await pending.removeValue(forKey: next)!.value
        }
        // A complete walk: series the site no longer lists go.
        if full && page.nextCursor == nil { apply(Catalog.merged([], fresh: fresh) { self.identity($0) }, total: page.total, complete: true) }
        catalog.fetchedAt = Date()
        save()
    }

    private func apply(_ series: [HomeSeries], total: Int?, complete: Bool) {
        let changed = series != catalog.series
        catalog.series = series
        if let total { catalog.total = total }
        catalog.complete = catalog.complete || complete
        var routesChanged = false
        for entry in series where routes[identity(entry)] != entry.slug {
            routes[identity(entry)] = entry.slug
            routesChanged = true
        }
        if routesChanged { let routes = routes; routesWriter.save(json: routes) }
        guard changed else { return }
        save()
        let rows = rows(series)
        Task { await chapters.setRows(rows) }
        NotificationCenter.default.post(name: .catalogChanged, object: nil)
        planSoon()
    }

    private func save() { let catalog = catalog; catalogWriter.save(json: catalog) }

    private func rows(_ series: [HomeSeries]) -> [String: [String]] {
        Dictionary(series.map { (identity($0), $0.chapters.map(\.chapterId)) }, uniquingKeysWith: { first, _ in first })
    }

    // MARK: readers

    func reading(_ screen: AnyObject, _ reading: Reading?) {
        let id = ObjectIdentifier(screen)
        readers[id] = reading
        if reading != nil { focus = id } else if focus == id { focus = nil }
        planSoon()
    }

    // MARK: the download plan

    func planSoon() {
        guard !planScheduled else { return }
        planScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            planScheduled = false
            Task { await self.plan() }
        }
    }

    private func newer(than chapter: String, in list: [String]) -> String? {
        guard let index = list.firstIndex(of: chapter), index > 0 else { return nil }
        return list[index - 1]
    }

    // Phase one reads only the phone (so nothing kept is deleted for want of the network);
    // missing chapters and lists are then asked for, each answer planning again.
    private func plan() async {
        var items: [ImageItem] = [], retained = Set<String>(), seen = Set<String>()
        var missing: [(series: String, slug: String, chapter: String)] = []
        var listless: [(series: String, slug: String)] = []
        var unsized: [String: (series: String, chapter: String, index: Int)] = [:]
        func add(_ data: ChapterData, series: String, from page: Int = 0) {
            let pages = data.images.map { ImageItem(url: $0.url, cover: false) }
            for (index, image) in data.images.enumerated() where image.width == nil { unsized[pages[index].name] = (series, data.chapterId, index) }
            let start = min(max(0, page), pages.count)
            for item in pages[start...] + pages[..<start] where seen.insert(item.name).inserted { items.append(item) }
            retained.formUnion(pages.map(\.name))
        }
        func want(_ series: String, _ slug: String, _ chapter: String, from page: Int = 0) async {
            if let data = await chapters.savedChapter(series: series, chapterId: chapter) { add(data, series: series, from: page) }
            else { missing.append((series, slug, chapter)) }
        }
        // The chapter on screen from its page on, then the next one.
        if let focus, let reading = readers[focus] {
            await want(reading.series, reading.slug, reading.chapter, from: reading.page)
            if let list = await chapters.knownList(series: reading.series), let next = newer(than: reading.chapter, in: list) {
                await want(reading.series, reading.slug, next)
            }
        }
        for progress in state.started {
            let series = progress.seriesSlug, slug = slug(series)
            let list = await chapters.knownList(series: series)
            let age = await chapters.listAge(series)
            if list == nil || age > 900 { listless.append((series, slug)) }
            let next = list.flatMap { newer(than: progress.chapterId, in: $0) }
            for chapter in progress.complete ? [next, progress.chapterId] : [progress.chapterId, next] {
                if let chapter { await want(series, slug, chapter, from: chapter == progress.chapterId ? progress.imageIndex : 0) }
            }
        }
        // Chapters open in readers stay while they are open.
        for reading in readers.values {
            for chapter in reading.chapters {
                if let data = await chapters.savedChapter(series: reading.series, chapterId: chapter) {
                    retained.formUnion(data.images.map { ImageItem(url: $0.url, cover: false).name })
                    for (index, image) in data.images.enumerated() where image.width == nil { unsized[ImageItem(url: image.url, cover: false).name] = (reading.series, chapter, index) }
                }
            }
        }
        for series in catalog.series where !series.coverUrl.isEmpty {
            let item = ImageItem(url: series.coverUrl, cover: true)
            if seen.insert(item.name).inserted { items.append(item) }
        }
        self.unsized = unsized
        await images.setRetained(retained)
        await images.setPlan(items)
        for name in await images.completed(Array(unsized.keys)) { finished(name) }
        prepare(missing: missing, lists: listless)
    }

    private func prepare(missing: [(series: String, slug: String, chapter: String)], lists: [(series: String, slug: String)]) {
        let now = Date()
        for (series, slug, chapter) in missing {
            let key = FileKey.chapter(series, chapter)
            if preparing.contains(key) || unavailable[key].map({ now.timeIntervalSince($0) < 900 }) == true { continue }
            preparing.insert(key)
            Task {
                do {
                    if try await chapters.chapter(series: series, slug: slug, chapterId: chapter, urgent: false) == nil { unavailable[key] = Date() }
                    else { planSoon() }
                } catch { unavailable[key] = Date().addingTimeInterval(-840) }
                preparing.remove(key)
            }
        }
        for (series, slug) in lists {
            let key = "list:" + series
            if preparing.contains(key) { continue }
            preparing.insert(key)
            Task {
                if (try? await chapters.fetchList(series: series, slug: slug, urgent: false)) != nil { planSoon() }
                preparing.remove(key)
            }
        }
    }

    // A chapter with every page size that can be known before its images show: the saved
    // sizes, else those of pages already on the phone (read from their headers, and saved),
    // so the strip is laid out once and nothing moves while it loads.
    func sized(_ data: ChapterData, series: String) async -> ChapterData {
        let missing = data.images.indices.filter { data.images[$0].width == nil }
        guard !missing.isEmpty else { return data }
        let names = missing.map { ImageItem(url: data.images[$0].url, cover: false).name }
        let ready = Set(await images.completed(names))
        let root = images.root
        let found = await Task.detached(priority: .userInitiated) { () -> [Int: CGSize] in
            var found: [Int: CGSize] = [:]
            for (index, name) in zip(missing, names) where ready.contains(name) {
                if let size = Library.pixelSize(root.appendingPathComponent(name)) { found[index] = size }
            }
            return found
        }.value
        guard !found.isEmpty else { return data }
        var data = data
        for (index, size) in found {
            data.images[index].width = Double(size.width)
            data.images[index].height = Double(size.height)
        }
        await chapters.files.recordSizes(found, series: series, chapterId: data.chapterId)
        return data
    }

    nonisolated static func pixelSize(_ file: URL) -> CGSize? {
        guard let source = CGImageSourceCreateWithURL(file as CFURL, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0 else { return nil }
        return CGSize(width: width, height: height)
    }

    // An image arrived: a page of unknown size has its size recorded (in batches).
    private func finished(_ item: ImageItem) { finished(item.name) }

    private func finished(_ name: String) {
        guard let place = unsized.removeValue(forKey: name) else { return }
        let file = images.root.appendingPathComponent(name)
        Task.detached(priority: .utility) {
            guard let size = Library.pixelSize(file) else { return }
            await MainActor.run { [weak self] in self?.record(size, at: place) }
        }
    }

    private func record(_ size: CGSize, at place: (series: String, chapter: String, index: Int)) {
        let key = FileKey.chapter(place.series, place.chapter)
        sizes[key, default: (place.series, place.chapter, [:])].sizes[place.index] = size
        guard !sizesScheduled else { return }
        sizesScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self else { return }
            sizesScheduled = false
            let batch = sizes
            sizes = [:]
            let files = chapters.files
            Task { for entry in batch.values { await files.recordSizes(entry.sizes, series: entry.series, chapterId: entry.chapter) } }
        }
    }

    // MARK: away from the screen

    // Leaving the screen: unfinished planned files go to iOS's background session.
    func handOff() { Task { await handOffNow() } }

    private func handOffNow() async {
        let referer = provider.origin.absoluteString + "/"
        let items = await images.unfinished(limit: 400).compactMap { item -> BackgroundTransfers.Item? in
            guard let url = URL(string: item.url) else { return nil }
            return BackgroundTransfers.Item(url: url, headers: ["Referer": referer], file: item.name)
        }
        if !items.isEmpty { await transfers.handOff(items) }
    }

    func paused() { Task { await images.setActive(false) } }

    func resumed() {
        Task {
            await transfers.reclaim()
            await images.setActive(true)
        }
        planSoon()
    }

    var debugState: [String: Any] {
        ["catalog": catalog.series.count, "complete": catalog.complete, "refreshing": refreshing, "error": catalogError ?? "",
         "started": state.started.count, "readers": readers.count]
    }
}
