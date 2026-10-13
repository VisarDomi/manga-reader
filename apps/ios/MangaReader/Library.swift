import Foundation
import ImageIO
import KitCore
import KitLifecycle
import KitNet

extension Notification.Name {
    static let catalogChanged = Notification.Name("MangaCatalogChanged")
    static let coverChanged = Notification.Name("MangaCoverChanged")
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
    private let positionsWriter: BackgroundWriter
    private let transfers: BackgroundTransfers
    private var readers: [ObjectIdentifier: Registered] = [:]
    private var positions: [String: Position]
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

    // A reader screen while it exists (on screen, or kept for going forward): its chapters stay;
    // the one on screen most recently comes first in the plan.
    private final class Registered {
        weak var screen: AnyObject?
        var reading: Reading
        var visible: Bool
        var shown: Date
        init(screen: AnyObject, reading: Reading, visible: Bool) {
            self.screen = screen
            self.reading = reading
            self.visible = visible
            shown = Date()
        }
    }

    // Where a series was left to the point (the reading state keeps only the page): reopening
    // it at its saved page returns exactly there, as going forward does (positions.json).
    struct Position: Codable, Equatable {
        var chapter: String
        var index: Int
        var fraction: Double
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
        positionsWriter = BackgroundWriter(url: root.appendingPathComponent("positions.json"), label: "manga-positions")
        catalog = (try? DurableFile.readJSON(Catalog.self, from: catalogWriter.url)) ?? Catalog()
        routes = (try? DurableFile.readJSON([String: String].self, from: routesWriter.url)) ?? [:]
        positions = (try? DurableFile.readJSON([String: Position].self, from: positionsWriter.url)) ?? [:]
        let images = images
        transfers = BackgroundTransfers(identifier: bundleID + ".images", root: root, connections: 4,
                                        accept: { $0.statusCode == 200 && $0.mimeType?.hasPrefix("image/") == true },
                                        committed: { item, response in
            let file = root.appendingPathComponent(item.file)
            if item.file.hasPrefix("covers/") { ImageFiles.saveCheck(for: file, response: response) }
            try? DurableFile.write(Data((response.mimeType ?? "image/jpeg").utf8), to: file.appendingPathExtension("mime"))
            Task { await images.committed(item.file) }
        })
        Task { await chapters.onListChange { _ in Task { @MainActor [weak self] in self?.planSoon() } } }
        Task { await images.onFinished { item in Task { @MainActor [weak self] in self?.finished(item) } } }
        Task { await images.onCoverChanged { item in Task { @MainActor [weak self] in self?.coverChanged(item.url) } } }
        let series = catalog.series, source = self.chapters, site = self.provider
        Task.detached(priority: .utility) {
            let rows = Dictionary(series.map { (Self.identity($0, site), $0.chapters.map(\.chapterId)) }, uniquingKeysWith: { first, _ in first })
            await source.setRows(rows)
        }
        NotificationCenter.default.addObserver(forName: .progressChanged, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.planSoon() }
        }
    }

    func identity(_ series: HomeSeries) -> String { Self.identity(series, provider) }
    nonisolated static func identity(_ series: HomeSeries, _ provider: any MangaProvider) -> String { series.historyId ?? provider.identity(series.slug) }

    // Bumped whenever the catalog's series change (screens compare this, not the series).
    private(set) var catalogVersion = 0

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

    // One page after another; each is merged into the catalog off the main thread (the main
    // thread only takes the result: Home scrolls while the walk runs).
    private struct Step: Sendable {
        var series: [HomeSeries]
        var changed: Bool
        var unchanged: Bool
        var rows: [String: [String]]
        var routes: [String: String]?
    }

    private nonisolated static func step(base: [HomeSeries], fresh: [HomeSeries], page: [HomeSeries], current: [HomeSeries], routes: [String: String],
                                         known: [String: HomeSeries], provider: any MangaProvider) -> Step {
        let identity = { (series: HomeSeries) in Self.identity(series, provider) }
        let merged = Catalog.merged(base, fresh: fresh, identity: identity)
        var newRoutes = routes, routesChanged = false
        for entry in merged where newRoutes[identity(entry)] != entry.slug {
            newRoutes[identity(entry)] = entry.slug
            routesChanged = true
        }
        let changed = merged != current
        return Step(series: merged, changed: changed, unchanged: !page.isEmpty && page.allSatisfy { known[identity($0)] == $0 },
                    rows: changed ? Dictionary(merged.map { (identity($0), $0.chapters.map(\.chapterId)) }, uniquingKeysWith: { first, _ in first }) : [:],
                    routes: routesChanged ? newRoutes : nil)
    }

    private func walk(full: Bool) async throws {
        let base = catalog.series
        let provider = provider
        let known = await Task.detached(priority: .utility) {
            Dictionary(base.map { (Self.identity($0, provider), $0) }, uniquingKeysWith: { first, _ in first })
        }.value
        var fresh: [HomeSeries] = []
        var pending: [String: Task<HomePage, Error>] = [:]
        var seen = Set<String>()
        defer { pending.values.forEach { $0.cancel() } }
        let chapters = chapters
        // Catalog pages are background work: they wait while a chapter is being opened.
        let fetch = { @Sendable (cursor: String?) in Task { try await chapters.background { try await provider.home(cursor) } } }
        var page = try await fetch(nil).value
        while true {
            try Task.checkCancellation()
            fresh += page.series
            let (snapshot, current, routes, pageSeries) = (fresh, catalog.series, routes, page.series)
            let step = await Task.detached(priority: .utility) {
                Self.step(base: base, fresh: snapshot, page: pageSeries, current: current, routes: routes, known: known, provider: provider)
            }.value
            apply(step, total: page.total, complete: false)
            guard let next = page.nextCursor, full || !step.unchanged else { break }
            guard seen.insert(next).inserted else { throw ProviderError.invalid("The site repeated catalog page \(next)") }
            if pending[next] == nil { pending[next] = fetch(next) }
            // A full walk keeps up to three pages in flight.
            for cursor in page.prefetchCursors where full && pending.count < 3 && !seen.contains(cursor) && pending[cursor] == nil {
                pending[cursor] = fetch(cursor)
            }
            page = try await pending.removeValue(forKey: next)!.value
        }
        // A complete walk: series the site no longer lists go.
        if full && page.nextCursor == nil {
            let (snapshot, current, routes, pageSeries) = (fresh, catalog.series, routes, page.series)
            let step = await Task.detached(priority: .utility) {
                Self.step(base: [], fresh: snapshot, page: pageSeries, current: current, routes: routes, known: known, provider: provider)
            }.value
            apply(step, total: page.total, complete: true)
        }
        catalog.fetchedAt = Date()
        save()
    }

    private func apply(_ step: Step, total: Int?, complete: Bool) {
        catalog.series = step.series
        if let total { catalog.total = total }
        catalog.complete = catalog.complete || complete
        if let newRoutes = step.routes {
            routes = newRoutes
            routesWriter.save(json: newRoutes)
        }
        guard step.changed else { return }
        catalogVersion += 1
        save()
        let rows = step.rows
        Task { await chapters.setRows(rows) }
        NotificationCenter.default.post(name: .catalogChanged, object: nil)
        planSoon()
    }

    private func save() { let catalog = catalog; catalogWriter.save(json: catalog) }


    // MARK: readers

    func reading(_ screen: AnyObject, _ reading: Reading, visible: Bool) {
        let id = ObjectIdentifier(screen)
        if let known = readers[id], known.screen === screen {
            known.reading = reading
            if visible && !known.visible { known.shown = Date() }
            known.visible = visible
        } else {
            readers[id] = Registered(screen: screen, reading: reading, visible: visible)
        }
        planSoon()
    }

    // The reader on screen (the most recently shown, if several think so).
    private var focused: Reading? {
        readers.values.filter { $0.screen != nil && $0.visible }.max { $0.shown < $1.shown }?.reading
    }

    // MARK: covers

    // A cover the site replaced (same address, new bytes): a new version for the screens'
    // image cache, so cards on screen show the new one.
    private var coverVersions: [String: Int] = [:]
    private var coverAsked: [String: Date] = [:]

    func coverVersion(_ url: String) -> Int { coverVersions[url] ?? 0 }

    func coverShown(_ url: String) {
        guard !url.isEmpty, coverAsked[url].map({ Date().timeIntervalSince($0) > ImageFiles.recheckAfter }) ?? true else { return }
        coverAsked[url] = Date()
        let images = images, item = ImageItem(url: url, cover: true)
        Task { await images.recheck(item) }
    }

    private func coverChanged(_ url: String) {
        coverVersions[url, default: 0] += 1
        NotificationCenter.default.post(name: .coverChanged, object: nil, userInfo: ["url": url])
    }

    // MARK: positions

    func position(_ series: String) -> Position? { positions[series] }

    func savePosition(_ position: Position, series: String) {
        guard positions[series] != position else { return }
        positions[series] = position
        let positions = positions
        positionsWriter.save(json: positions)
    }

    func flushPositions() { positionsWriter.flush() }

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

    private nonisolated static func newer(than chapter: String, in list: [String]) -> String? {
        guard let index = list.firstIndex(of: chapter), index > 0 else { return nil }
        return list[index - 1]
    }

    // Phase one reads only the phone (so nothing kept is deleted for want of the network);
    // missing chapters and lists are then asked for, each answer planning again. The main thread
    // only takes a snapshot of what to plan for and applies the outcome; the plan itself (every
    // page and cover of every started series) is worked out off it.
    private struct PlanInput: Sendable {
        var focused: Reading?
        var started: [(series: String, slug: String, chapter: String, page: Int, complete: Bool)]
        var open: [Reading]
        var covers: [String]
    }

    private struct PlanOutput: Sendable {
        var unsized: [String: (series: String, chapter: String, index: Int)] = [:]
        var completedUnsized: [String] = []
        var missing: [(series: String, slug: String, chapter: String)] = []
        var listless: [(series: String, slug: String)] = []
    }

    private func plan() async {
        readers = readers.filter { $0.value.screen != nil }
        let input = PlanInput(focused: focused, started: state.started.map { ($0.seriesSlug, slug($0.seriesSlug), $0.chapterId, $0.imageIndex, $0.complete) },
                              open: readers.values.map(\.reading), covers: catalog.series.map(\.coverUrl))
        let output = await Self.plan(input, chapters: chapters, images: images)
        unsized = output.unsized
        for name in output.completedUnsized { finished(name) }
        prepare(missing: output.missing, lists: output.listless)
    }

    private nonisolated static func plan(_ input: PlanInput, chapters: ChapterSource, images: ImageFiles) async -> PlanOutput {
        var output = PlanOutput()
        var items: [ImageItem] = [], retained = Set<String>(), seen = Set<String>()
        func add(_ data: ChapterData, series: String, from page: Int = 0) {
            let pages = data.images.map { ImageItem(url: $0.url, cover: false) }
            for (index, image) in data.images.enumerated() where image.width == nil { output.unsized[pages[index].name] = (series, data.chapterId, index) }
            let start = min(max(0, page), pages.count)
            for item in pages[start...] + pages[..<start] where seen.insert(item.name).inserted { items.append(item) }
            retained.formUnion(pages.map(\.name))
        }
        func want(_ series: String, _ slug: String, _ chapter: String, from page: Int = 0) async {
            if let data = await chapters.savedChapter(series: series, chapterId: chapter) { add(data, series: series, from: page) }
            else { output.missing.append((series, slug, chapter)) }
        }
        // The chapter on screen from its page on, then the next one.
        if let reading = input.focused {
            await want(reading.series, reading.slug, reading.chapter, from: reading.page)
            if let list = await chapters.knownList(series: reading.series), let next = newer(than: reading.chapter, in: list) {
                await want(reading.series, reading.slug, next)
            }
        }
        for progress in input.started {
            let list = await chapters.knownList(series: progress.series)
            let age = await chapters.listAge(progress.series)
            if list == nil || age > 900 { output.listless.append((progress.series, progress.slug)) }
            let next = list.flatMap { newer(than: progress.chapter, in: $0) }
            for chapter in progress.complete ? [next, progress.chapter] : [progress.chapter, next] {
                if let chapter { await want(progress.series, progress.slug, chapter, from: chapter == progress.chapter ? progress.page : 0) }
            }
        }
        // Chapters open in readers stay while they are open.
        for reading in input.open {
            for chapter in reading.chapters {
                if let data = await chapters.savedChapter(series: reading.series, chapterId: chapter) {
                    retained.formUnion(data.images.map { ImageItem(url: $0.url, cover: false).name })
                    for (index, image) in data.images.enumerated() where image.width == nil {
                        output.unsized[ImageItem(url: image.url, cover: false).name] = (reading.series, chapter, index)
                    }
                }
            }
        }
        for url in input.covers where !url.isEmpty {
            let item = ImageItem(url: url, cover: true)
            if seen.insert(item.name).inserted { items.append(item) }
        }
        await images.setRetained(retained)
        await images.setPlan(items)
        output.completedUnsized = await images.completed(Array(output.unsized.keys))
        return output
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

    // The same at once, from the pages already on the phone (their headers only), for a chapter
    // laid out before the first frame; the sizes found are saved afterwards.
    func sizedNow(_ data: ChapterData, series: String) -> ChapterData {
        var data = data, found: [Int: CGSize] = [:]
        for index in data.images.indices where data.images[index].width == nil {
            guard let file = images.localFile(ImageItem(url: data.images[index].url, cover: false)), let size = Library.pixelSize(file) else { continue }
            data.images[index].width = Double(size.width)
            data.images[index].height = Double(size.height)
            found[index] = size
        }
        if !found.isEmpty {
            let files = chapters.files, chapterId = data.chapterId
            Task { await files.recordSizes(found, series: series, chapterId: chapterId) }
        }
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
