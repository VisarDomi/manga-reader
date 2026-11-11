import Foundation
import MangaSources
#if canImport(ImageIO)
import ImageIO
#endif
import KitCore
import KitLifecycle
import KitNet

extension Notification.Name {
    public static let catalogChanged = Notification.Name("MangaCatalogChanged")
    public static let coverChanged = Notification.Name("MangaCoverChanged")
    public static let pageDimensionsKnown = Notification.Name("MangaPageDimensionsKnown")
}

// The app's model: the catalog (kept on the phone, refreshed in the background), reading
// progress, saved chapters, and what downloads. Every touched series keeps its current and
// next chapter on the phone; a new chapter downloads as soon as the catalog or a chapter list
// shows it. The chapter being read comes first, then the most recently read series, then
// the catalog's covers. Downloaded pages leaving current/next expire after 24 hours.
@MainActor
public final class Library: CheckpointStore {
    public let provider: any MangaProvider
    public let state: ReadingState
    public let chapters: ChapterSource
    public let images: ImageFiles
    let root: URL
    public private(set) var catalog: Catalog
    public private(set) var catalogError: String?
    public private(set) var refreshing = false
    private(set) var routes: [String: String]
    private let catalogWriter: BackgroundWriter
    private let routesWriter: BackgroundWriter
    private let positionsWriter: BackgroundWriter
    private let transfers: SiteTransfers
    private var transferOwnership = TransferOwnership()
    private var readers: [ObjectIdentifier: Registered] = [:]
    private var positions: [String: Position]
    private var planning = CoalescedWork()
    private var planTask: Task<Void, Never>?
    private var priorityTask: Task<Void, Never>?
    private var fullPlans = 0
    private var priorityPlans = 0
    private var measuring = Set<String>()
    private var backgroundPreparing = Set<String>()
    private var preparing = Set<String>()
    private var unavailable: [String: Date] = [:]
    private var preparationWake: Task<Void, Never>?
    private var preparationWakeAt: Date?
    private var observations: [NotificationObservation] = []
    private var lastRefresh: Date?
    private var legacyTransfersCleared = false
    private var clearingTransfers: Task<Void, Never>?
    // Pages without a known size, by image file: where they belong.
    private struct PagePlace: Hashable, Sendable {
        let series: String
        let chapter: String
        let index: Int
    }
    private var unsized: [String: Set<PagePlace>] = [:]

    // What a reader screen shows: its series, the chapters it holds and where it is.
    public struct Reading: Equatable, Sendable {
        public var series: String
        public var slug: String
        public var chapters: [String]
        public var chapter: String
        public var page: Int

        public init(series: String, slug: String, chapters: [String], chapter: String, page: Int) {
            self.series = series; self.slug = slug; self.chapters = chapters; self.chapter = chapter; self.page = page
        }
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
    public struct Position: Codable, Equatable, Sendable {
        public var chapter: String
        public var index: Int
        public var fraction: Double
        public var zoom: ZoomState? = nil
        public var aspect: Double? = nil
        public var point: Double? = nil

        public init(chapter: String, index: Int, fraction: Double, zoom: ZoomState? = nil, aspect: Double? = nil, point: Double? = nil) {
            self.chapter = chapter; self.index = index; self.fraction = fraction; self.zoom = zoom; self.aspect = aspect; self.point = point
        }
    }

    public init(provider: any MangaProvider, root: URL, bundleID: String, limiter: RequestLimiter? = nil) {
        self.provider = provider
        self.root = root
        state = ReadingState(directory: root, provider: provider.key)
        chapters = ChapterSource(provider: provider, files: ChapterFiles(directory: root))
        let referer = provider.origin.absoluteString + "/"
        let limiter = limiter ?? RequestLimiter(.provider(provider.key), provider: provider.key, file: root.appendingPathComponent("request-limits.json"))
        images = ImageFiles(root: root, http: HTTPClient(.init(connectionsPerHost: 6, requestTimeout: 20, resourceTimeout: 90, waitsForConnectivity: true)), referer: referer, limiter: limiter)
        catalogWriter = BackgroundWriter(url: root.appendingPathComponent("catalog.json"), label: "manga-catalog")
        routesWriter = BackgroundWriter(url: root.appendingPathComponent("routes.json"), label: "manga-routes")
        positionsWriter = BackgroundWriter(url: root.appendingPathComponent("positions.json"), label: "manga-positions")
        catalog = (try? DurableFile.readJSON(Catalog.self, from: catalogWriter.url)) ?? Catalog()
        routes = (try? DurableFile.readJSON([String: String].self, from: routesWriter.url)) ?? [:]
        positions = (try? DurableFile.readJSON([String: Position].self, from: positionsWriter.url)) ?? [:]
        let images = images
        transfers = SiteTransfers(identifier: bundleID + ".images", root: root, limiter: limiter,
                                        accept: { $0.statusCode == 200 && $0.mimeType?.hasPrefix("image/") == true },
                                        committed: { item, response in
            let file = root.appendingPathComponent(item.file)
            if item.file.hasPrefix("covers/") { ImageFiles.saveCheck(for: file, response: response) }
            try? DurableFile.write(Data((response.mimeType ?? "image/jpeg").utf8), to: file.appendingPathExtension("mime"))
            Task { await images.committed(item.file) }
        })
        Task { await chapters.onListChange { _ in Task { @MainActor [weak self] in self?.planSoon() } } }
        Task { await images.onFinished { item in Task { @MainActor [weak self] in self?.finished(item) } } }
        let chapterSource = chapters
        Task { await images.onReaderWorkChanged { busy, revision in
            Task { await chapterSource.setReaderBusy(busy, revision: revision) }
        } }
        Task { await images.onCoverChanged { item in Task { @MainActor [weak self] in self?.coverChanged(item.url) } } }
        let series = catalog.series, source = self.chapters, site = self.provider
        Task.detached(priority: .utility) {
            let rows = Dictionary(series.map { (Self.identity($0, site), $0.chapters.map(\.chapterId)) }, uniquingKeysWith: { first, _ in first })
            await source.setRows(rows)
        }
        observations.append(NotificationObservation(name: .progressChanged) { [weak self] note in
            let changed = note.userInfo?["preparationChanged"] as? Bool ?? true
            MainActor.assumeIsolated { if changed { self?.planSoon() } }
        })
    }

    public func identity(_ series: HomeSeries) -> String { Self.identity(series, provider) }
    nonisolated static func identity(_ series: HomeSeries, _ provider: any MangaProvider) -> String { series.historyId ?? provider.identity(series.slug) }

    // Bumped whenever the catalog's series change (screens compare this, not the series).
    public private(set) var catalogVersion = 0

    // The series' current URL slug (Asura's rotates).
    public func slug(_ series: String) -> String { routes[series] ?? series }

    public func handleEvents(_ completion: @escaping () -> Void, background: Bool) {
        let ticket = background ? transferOwnership.handOff() : nil
        Task {
            if background { await images.setActive(false) }
            await clearLegacyTransfers()
            await plan()
            if let ticket, transferOwnership.ownsHandoff(ticket) { await handOffNow(ticket) }
            // A later activation/handoff owns the session now. This event may
            // reconnect its completion handler, but must not reclaim that work.
            else if !background, transferOwnership.phase == .foreground { await transfers.reclaim() }
            let continues: Bool
            if case .background = transferOwnership.phase { continues = true } else { continues = false }
            await transfers.handleEvents(SiteTransfers.Completion(call: completion), continueDownloads: continues)
        }
    }

    private func clearLegacyTransfers() async {
        if legacyTransfersCleared { return }
        if !(await images.needsRetentionMigration()) { legacyTransfersCleared = true; return }
        let task = clearingTransfers ?? Task { [transfers] in
            await transfers.reclaim()
            await transfers.handOff([])
            await transfers.reclaim()
        }
        clearingTransfers = task
        await task.value
        legacyTransfersCleared = true; clearingTransfers = nil
    }

    // MARK: catalog

    // Pages from the newest; a partial refresh stops at the first page that changes nothing.
    public func refreshCatalog(full requested: Bool = false) {
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
    public func backgroundRefresh() async {
        let ticket = transferOwnership.handOff()
        await images.setActive(false)
        guard transferOwnership.ownsHandoff(ticket) else { return }
        await clearLegacyTransfers()
        if !refreshing {
            refreshing = true
            lastRefresh = Date()
            do { try await walk(full: false) } catch { Log.network.info("Background catalog: \(error.localizedDescription, privacy: .public)") }
            refreshing = false
        }
        await plan()
        for _ in 0..<20 where !preparing.isEmpty && !Task.isCancelled { try? await Task.sleep(for: .seconds(1)) }
        await plan()
        await handOffNow(ticket)
    }

    // Back on screen after a while, or when the catalog was never complete.
    public func refreshIfStale() {
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

    public func reading(_ screen: AnyObject, _ reading: Reading, visible: Bool) {
        let id = ObjectIdentifier(screen)
        if let known = readers[id], known.screen === screen {
            if known.reading == reading && known.visible == visible { return }
            let pageOnly = known.visible == visible && known.reading.series == reading.series
                && known.reading.slug == reading.slug && known.reading.chapter == reading.chapter
                && known.reading.chapters == reading.chapters
            known.reading = reading
            if visible && !known.visible { known.shown = Date() }
            known.visible = visible
            if pageOnly {
                if visible { prioritizeFocused() }
                return
            }
        } else {
            readers[id] = Registered(screen: screen, reading: reading, visible: visible)
        }
        priorityTask?.cancel()
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

    public func coverVersion(_ url: String) -> Int { coverVersions[url] ?? 0 }

    public func coverShown(_ url: String) {
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

    public func position(_ series: String) -> Position? { positions[series] }

    public func recordPosition(_ position: Position, series: String, totalImages: Int) {
        state.save(series: series, chapterId: position.chapter, imageIndex: position.index, totalImages: totalImages)
        guard positions[series] != position else { return }
        positions[series] = position
        let positions = positions
        positionsWriter.save(json: positions)
    }

    public func flush() {
        state.flush()
        catalogWriter.flush()
        routesWriter.flush()
        positionsWriter.flush()
    }

    // MARK: the download plan

    public func planSoon() {
        if planning.request() { schedulePlan() }
    }

    private func schedulePlan() {
        DispatchQueue.main.async { [weak self] in
            guard let self, planning.phase == .scheduled else { return }
            Task { await self.plan() }
        }
    }

    private func prioritizeFocused() {
        priorityTask?.cancel()
        guard let reading = focused else { return }
        priorityTask = Task(priority: .userInitiated) { [weak self] in
            guard let self else { return }
            let output = await Self.plan(PlanInput(focused: reading, started: [], open: [], covers: []), chapters: chapters, images: images)
            guard !Task.isCancelled else { return }
            priorityPlans += 1
            await applyReader(output)
        }
    }

    private func applyReader(_ output: PlanOutput) async {
        unsized.merge(output.unsized, uniquingKeysWith: { $0.union($1) })
        await images.prioritizeReader(output.items, awaitingMetadata: output.readerMetadataPending)
        await chapters.prioritize(output.missing.map { FileKey.chapter($0.series, $0.chapter) }
                                  + output.listless.map { "list:" + $0.series })
        for name in output.completedUnsized { finished(name) }
        prepare(missing: output.missing, lists: output.listless)
    }

    private nonisolated static func newer(than chapter: String, in list: [String]) -> String? {
        guard let index = list.firstIndex(of: chapter), index > 0 else { return nil }
        return list[index - 1]
    }

    // Phase one reads only the phone (so nothing kept is deleted for want of the network);
    // missing chapters and lists are then asked for, each answer planning again. The main thread
    // only takes a snapshot of what to plan for and applies the outcome; the plan itself (every
    // page and cover of every catalog entry) is worked out off it.
    private struct PlanInput: Sendable {
        var focused: Reading?
        var started: [(series: String, slug: String, chapter: String, page: Int, complete: Bool)]
        var open: [Reading]
        var covers: [String]
    }

    private struct PlanOutput: Sendable {
        var unsized: [String: Set<PagePlace>] = [:]
        var completedUnsized: [String] = []
        var missing: [(series: String, slug: String, chapter: String, urgent: Bool)] = []
        var listless: [(series: String, slug: String, urgent: Bool)] = []
        var items: [ImageItem] = []
        var retained = Set<String>()
        var readerNames: Set<String>?
        var readerMetadataPending = false
    }

    private func plan() async {
        if planning.isRunning {
            planning.request()
            if let planTask { await planTask.value }
            return
        }
        guard planning.begin() else { return }
        let task = Task { [self] in
            defer {
                planTask = nil
                if planning.finish() { schedulePlan() }
            }
            await performPlan()
        }
        planTask = task
        await task.value
    }

    private func performPlan() async {
        await clearLegacyTransfers()
        repeat {
            fullPlans += 1
            planning.consumePending()
            readers = readers.filter { $0.value.screen != nil }
            let started = state.started
            let input = PlanInput(focused: focused, started: started.map { ($0.seriesSlug, slug($0.seriesSlug), $0.chapterId, $0.imageIndex, $0.complete) },
                                  open: readers.values.map(\.reading), covers: catalog.series.map(\.coverUrl))
            // Admit the reader before scanning a large Home catalog. The old background
            // plan stays retained until the complete replacement has been computed.
            if let focused = input.focused {
                let reader = await Self.plan(PlanInput(focused: focused, started: [], open: [], covers: []), chapters: chapters, images: images)
                if Task.isCancelled { break }
                await applyReader(reader)
            }
            let output = await Self.plan(input, chapters: chapters, images: images)
            if Task.isCancelled { break }
            if planning.isPending { continue }
            unsized = output.unsized
            var grace = Set<String>()
            if await images.needsRetentionMigration() {
                var touched = Set(started.map(\.seriesSlug))
                if let focused { touched.insert(focused.series) }
                let site = provider
                grace = await chapters.files.existingPages(for: touched, identity: { site.identity($0) })
            }
            await images.setRetained(output.retained, migrationGrace: grace)
            await images.setPlan(output.items, readerNames: output.readerNames, awaitingReaderMetadata: output.readerMetadataPending,
                                 preservingReader: input.focused != focused)
            await chapters.prioritize(output.missing.filter(\.urgent).map { FileKey.chapter($0.series, $0.chapter) }
                                      + output.listless.filter(\.urgent).map { "list:" + $0.series })
            for name in output.completedUnsized { finished(name) }
            prepare(missing: output.missing, lists: output.listless)
        } while planning.isPending
    }

    private nonisolated static func plan(_ input: PlanInput, chapters: ChapterSource, images: ImageFiles) async -> PlanOutput {
        var output = PlanOutput()
        var items: [ImageItem] = [], retained = Set<String>(), seen = Set<String>()
        func add(_ data: ChapterData, series: String, from page: Int = 0) {
            let pages = data.images.map { ImageItem(url: $0.url, cover: false) }
            for (index, image) in data.images.enumerated() where !image.hasMeasuredDimensions {
                output.unsized[pages[index].name, default: []].insert(PagePlace(series: series, chapter: data.chapterId, index: index))
            }
            // The requested image first; then earlier boxes can become known without
            // waiting for every later page in this chapter to finish downloading.
            if pages.indices.contains(page), seen.insert(pages[page].name).inserted { items.append(pages[page]) }
            for item in pages where seen.insert(item.name).inserted { items.append(item) }
            retained.formUnion(pages.map(\.name))
        }
        func want(_ series: String, _ slug: String, _ chapter: String, from page: Int = 0, urgent: Bool = false) async {
            if let data = await chapters.savedChapter(series: series, chapterId: chapter) { add(data, series: series, from: page) }
            else { output.missing.append((series, slug, chapter, urgent))
                if urgent { output.readerMetadataPending = true } }
        }
        // The chapter on screen from its page on, then the next one.
        if let reading = input.focused {
            if !reading.chapter.isEmpty { await want(reading.series, reading.slug, reading.chapter, from: reading.page, urgent: true) }
            else { output.readerMetadataPending = true }
            if let list = await chapters.knownList(series: reading.series) {
                if let next = newer(than: reading.chapter, in: list) { await want(reading.series, reading.slug, next, urgent: true) }
                if await chapters.listAge(reading.series) > 900 { output.listless.append((reading.series, reading.slug, true)) }
            } else {
                output.listless.append((reading.series, reading.slug, true))
                output.readerMetadataPending = true
            }
            output.readerNames = Set(items.map(\.name))
        }
        // Home's covers must not wait behind the entire catalog's chapter bytes.
        // An open reader's current/next pair remains first.
        for url in input.covers where !url.isEmpty {
            if Task.isCancelled { return output }
            let item = ImageItem(url: url, cover: true)
            if seen.insert(item.name).inserted { items.append(item) }
        }
        for progress in input.started {
            if Task.isCancelled { return output }
            // The visible chapter wins while continuous scrolling has not yet
            // saved a settled position. Do not prepare a second pair for it.
            if progress.series == input.focused?.series { continue }
            let list = await chapters.knownList(series: progress.series)
            let age = await chapters.listAge(progress.series)
            if list == nil || age > 900 { output.listless.append((progress.series, progress.slug, false)) }
            let next = list.flatMap { newer(than: progress.chapter, in: $0) }
            for chapter in progress.complete ? [next, progress.chapter] : [progress.chapter, next] {
                if let chapter { await want(progress.series, progress.slug, chapter, from: chapter == progress.chapter ? progress.page : 0) }
            }
        }
        // Open-reader manifests may supply dimensions, but do not pin old page
        // files forever. Pages outside current/next use the durable 24-hour grace.
        for reading in input.open {
            if Task.isCancelled { return output }
            for chapter in reading.chapters {
                if let data = await chapters.savedChapter(series: reading.series, chapterId: chapter) {
                    for (index, image) in data.images.enumerated() where !image.hasMeasuredDimensions {
                        output.unsized[ImageItem(url: image.url, cover: false).name, default: []].insert(PagePlace(series: reading.series, chapter: chapter, index: index))
                    }
                }
            }
        }
        output.items = items
        output.retained = retained
        output.completedUnsized = await images.completed(Array(output.unsized.keys))
        return output
    }

    private func prepare(missing: [(series: String, slug: String, chapter: String, urgent: Bool)], lists: [(series: String, slug: String, urgent: Bool)]) {
        let now = Date()
        for (series, slug, chapter, urgent) in missing {
            let key = FileKey.chapter(series, chapter)
            if preparing.contains(key) || unavailable[key].map({ $0 > now }) == true { continue }
            if !urgent && backgroundPreparing.count >= 2 { continue }
            preparing.insert(key)
            if !urgent { backgroundPreparing.insert(key) }
            Task {
                do {
                    if try await chapters.chapter(series: series, slug: slug, chapterId: chapter, urgent: urgent) == nil {
                        unavailable[key] = Date().addingTimeInterval(urgent ? 15 : 900)
                    } else { unavailable[key] = nil }
                } catch { unavailable[key] = Date().addingTimeInterval(urgent ? 15 : 60) }
                preparing.remove(key); backgroundPreparing.remove(key)
                planSoon()
                if let retryAt = unavailable[key] { retryPreparation(at: retryAt) }
            }
        }
        for (series, slug, urgent) in lists {
            let key = "list:" + series
            if preparing.contains(key) || unavailable[key].map({ $0 > now }) == true { continue }
            if !urgent && backgroundPreparing.count >= 2 { continue }
            preparing.insert(key)
            if !urgent { backgroundPreparing.insert(key) }
            Task {
                if (try? await chapters.fetchList(series: series, slug: slug, urgent: urgent)) == nil {
                    let retryAt = Date().addingTimeInterval(urgent ? 15 : 60)
                    unavailable[key] = retryAt
                    retryPreparation(at: retryAt)
                } else { unavailable[key] = nil }
                preparing.remove(key); backgroundPreparing.remove(key)
                planSoon()
            }
        }
        if let next = unavailable.values.filter({ $0 > now }).min() { retryPreparation(at: next) }
    }

    private func retryPreparation(at date: Date) {
        guard preparationWakeAt.map({ $0 > date }) ?? true else { return }
        preparationWake?.cancel()
        preparationWakeAt = date
        preparationWake = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(max(0, date.timeIntervalSinceNow))) }
            catch { return }
            self?.preparationWakeAt = nil
            self?.preparationWake = nil
            self?.planSoon()
        }
    }

    // A chapter with every page size that can be known before its images show: the saved
    // sizes, else those of pages already on the phone (measured by the decoder, and saved),
    // so the strip is laid out once and nothing moves while it loads.
    public func sized(_ data: ChapterData, series: String) async -> ChapterData {
        let missing = data.images.indices.filter { !data.images[$0].hasMeasuredDimensions }
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
            data.images[index].dimensionsMeasured = true
        }
        await chapters.files.recordSizes(found, series: series, chapterId: data.chapterId)
        return data
    }

    // The same at once, from the pages already on the phone (without decoding display bitmaps), for a chapter
    // laid out before the first frame; the sizes found are saved afterwards.
    public func sizedNow(_ data: ChapterData, series: String) -> ChapterData {
        var data = data, found: [Int: CGSize] = [:]
        for index in data.images.indices where !data.images[index].hasMeasuredDimensions {
            guard let file = images.localFile(ImageItem(url: data.images[index].url, cover: false)), let size = Library.pixelSize(file) else { continue }
            data.images[index].width = Double(size.width)
            data.images[index].height = Double(size.height)
            data.images[index].dimensionsMeasured = true
            found[index] = size
        }
        if !found.isEmpty {
            let files = chapters.files, chapterId = data.chapterId
            Task { await files.recordSizes(found, series: series, chapterId: chapterId) }
        }
        return data
    }

    nonisolated static func pixelSize(_ file: URL) -> CGSize? { ImageDimensions.read(file) }

    // Persist measured geometry before telling the reader that its page box is ready.
    private func finished(_ item: ImageItem) { if !item.cover { finished(item.name) } }

    private func finished(_ name: String) {
        guard let places = unsized[name] else { return }
        guard measuring.insert(name).inserted else { return }
        let file = images.root.appendingPathComponent(name), files = chapters.files, images = images
        let priority: TaskPriority = places.contains(where: { $0.series == focused?.series }) ? .userInitiated : .utility
        Task.detached(priority: priority) { [weak self] in
            let size = Library.pixelSize(file)
            if let size {
                for place in places { await files.recordSizes([place.index: size], series: place.series, chapterId: place.chapter) }
            }
            else { await images.invalidate(name) }
            await MainActor.run { [weak self] in
                guard let self else { return }
                self.measuring.remove(name)
                if let size {
                    let remaining = (self.unsized[name] ?? []).subtracting(places)
                    self.unsized[name] = remaining.isEmpty ? nil : remaining
                    for place in places {
                        NotificationCenter.default.post(name: .pageDimensionsKnown, object: nil,
                            userInfo: ["series": place.series, "chapter": place.chapter, "index": place.index,
                                       "width": Double(size.width), "height": Double(size.height)])
                    }
                    if !remaining.isEmpty { self.finished(name) }
                }
            }
        }
    }

    // MARK: away from the screen

    // Leaving the screen: unfinished planned files go to iOS's background session.
    public func handOff() async { await handOffNow() }

    private func handOffNow(_ requested: UInt64? = nil) async {
        let ticket = requested ?? transferOwnership.handOff()
        guard transferOwnership.ownsHandoff(ticket), !Task.isCancelled else { return }
        await images.setActive(false)
        guard transferOwnership.ownsHandoff(ticket) else { return }
        let referer = provider.origin.absoluteString + "/"
        let items = await images.unfinished(limit: 400).compactMap { item -> SiteTransfers.Item? in
            guard let url = URL(string: item.url) else { return nil }
            return SiteTransfers.Item(url: url, headers: ["Referer": referer], file: item.name)
        }
        guard transferOwnership.ownsHandoff(ticket), !Task.isCancelled else { return }
        await transfers.handOff(items)
        transferOwnership.handedOff(ticket)
    }

    public func paused() {
        let owner = transferOwnership.phase
        Task {
            guard transferOwnership.phase == owner, owner != .foreground else { return }
            await images.setActive(false)
        }
    }

    public func resumed() {
        let ticket = transferOwnership.reclaim()
        Task {
            await clearLegacyTransfers()
            guard transferOwnership.ownsReclaim(ticket) else { return }
            await transfers.reclaim()
            guard transferOwnership.reclaimed(ticket) else { return }
            await images.setActive(true)
        }
        planSoon()
    }

    public var debugState: [String: Any] {
        ["catalog": catalog.series.count, "complete": catalog.complete, "refreshing": refreshing, "error": catalogError ?? "",
         "started": state.started.count, "readers": readers.count, "fullPlans": fullPlans, "priorityPlans": priorityPlans]
    }
}
