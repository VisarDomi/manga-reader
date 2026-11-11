import UIKit
import KitCore
import KitImages
import KitReader
import MangaLibrary
import MangaSources

enum ReaderStart: Codable, Hashable, Sendable {
    case top, last, first, image(Int)
}

// The reader's document and its preparation/progress workflow. The screen supplies
// a viewport and renders pages/messages; it never coordinates chapter caches,
// retries, dimension measurement, download priority or chapter-local positions.
@MainActor
final class ReadingSession {
    struct State: Codable {
        var chapter: String
        var position: StripPosition
    }
    struct Viewport { var live: StripPosition?; var saved: StripPosition? }
    struct Message: Equatable { var text: String; var error = false }
    enum Placement {
        case point(StripPosition), top(Int)
        var index: Int { switch self { case .point(let p): p.index; case .top(let i): i } }
    }
    private struct Part { var data: ChapterData; let first: Int }
    private enum Load {
        case loading, loaded, unavailable(retryAt: Date), failed(retryAt: Date)
    }
    private enum ListFetch { case waiting(until: Date), loading }

    private let library: Library
    private let series: String
    private let slug: String
    private var chapter: String?
    private let start: ReaderStart
    private var restoring: State?
    private let viewport: () -> Viewport
    private var parts: [Part] = []
    private var list: [String]?
    private var listFetch = ListFetch.waiting(until: .distantPast)
    private var loads: [String: Load] = [:]
    private var settled: (chapter: String, index: Int)?
    private var visible = false
    private var placed = false
    private var started = false
    private var observations: [NotificationObservation] = []

    var changed: (() -> Void)?
    var stateChanged: (() -> Void)?
    private(set) var documentID = 0
    private(set) var pages: [StripPage] = []
    private(set) var message: Message?
    private(set) var footer: Message?

    init(library: Library, series: String, slug: String, chapter: String?, start: ReaderStart,
         state: Data?, viewport: @escaping () -> Viewport) {
        self.library = library; self.series = series; self.slug = slug
        self.chapter = chapter; self.start = start; self.viewport = viewport
        restoring = state.flatMap { try? JSONDecoder().decode(State.self, from: $0) }
        if let restoring { self.chapter = restoring.chapter }
    }

    var route: Data {
        (try? JSONEncoder().encode(Route.reader(series: series, slug: slug,
            chapter: settled?.chapter ?? chapter, start: start))) ?? Data()
    }

    func snapshot() -> Data? {
        guard placed, let position = viewport().saved, let (part, index) = locate(position.index) else {
            return restoring.flatMap { try? JSONEncoder().encode($0) }
        }
        return try? JSONEncoder().encode(State(chapter: part.data.chapterId,
            position: position.at(index: index)))
    }

    func capture() {
        guard placed, let position = viewport().live else { return }
        save(position)
    }

    var placement: Placement? {
        guard !placed, let first = parts.first else { return nil }
        let index = min(requestedIndex, max(0, first.data.images.count - 1))
        if let restoring, restoring.chapter == first.data.chapterId { return .point(restoring.position.at(index: index)) }
        switch start { case .image, .last: return .top(index); default: return .point(StripPosition(index: index, fraction: 0)) }
    }

    func didPlace() { placed = true; restoring = nil; didLayout() }
    func didLayout() {
        guard placed, settled == nil, let position = viewport().live else { return }
        save(position); stateChanged?()
    }

    func setVisible(_ visible: Bool) {
        self.visible = visible
        report(chapter: settled?.chapter ?? chapter ?? "", page: settled?.index ?? requestedIndex)
    }

    func focus(_ index: Int) {
        guard placed, let (part, page) = locate(index) else { return }
        report(chapter: part.data.chapterId, page: page)
        continueReading()
    }

    func nearEnd() {
        if placed, let position = viewport().live, let (part, page) = locate(position.index) {
            report(chapter: part.data.chapterId, page: page)
        }
        continueReading()
    }

    static func savedState(_ position: Library.Position) -> Data? {
        try? JSONEncoder().encode(State(chapter: position.chapter, position: StripPosition(index: position.index,
            fraction: position.fraction, zoom: position.zoom, aspect: position.aspect, point: position.point)))
    }

    func save(_ position: StripPosition) {
        guard placed, let (part, index) = locate(position.index) else { return }
        let chapter = part.data.chapterId
        library.recordPosition(.init(chapter: chapter, index: index, fraction: position.fraction,
            zoom: position.zoom, aspect: position.aspect, point: position.point),
            series: series, totalImages: part.data.images.count)
        if settled?.chapter != chapter || settled?.index != index {
            settled = (chapter, index); report(chapter: chapter, page: index)
        }
    }

    func source(at index: Int) -> ImageSource {
        guard let item = image(at: index) else { return .load { throw CancellationError() } }
        let images = library.images
        return .load { try await images.file(item) }
    }
    func localFile(at index: Int) -> URL? { image(at: index).flatMap { library.images.localFile($0) } }
    func failedImage(at index: Int, error: Error) -> String? {
        guard !(error is CancellationError), let item = image(at: index) else { return nil }
        let images = library.images
        Task { await images.invalidate(item) }
        return "Retrying image…"
    }
    private func image(at index: Int) -> ImageItem? {
        locate(index).map { part, page in ImageItem(url: part.data.images[page].url, cover: false) }
    }
    private func locate(_ index: Int) -> (Part, Int)? {
        guard let part = parts.last(where: { $0.first <= index }), index - part.first < part.data.images.count else { return nil }
        return (part, index - part.first)
    }

    func startReading() {
        guard !started else { return }; started = true
        observations.append(NotificationObservation(name: UIApplication.didBecomeActiveNotification) { [weak self] _ in
            MainActor.assumeIsolated { self?.continueReading() }
        })
        observations.append(NotificationObservation(name: .pageDimensionsKnown) { [weak self] note in
            guard let series = note.userInfo?["series"] as? String,
                  let chapter = note.userInfo?["chapter"] as? String,
                  let index = note.userInfo?["index"] as? Int,
                  let width = note.userInfo?["width"] as? Double,
                  let height = note.userInfo?["height"] as? Double else { return }
            MainActor.assumeIsolated {
                guard let self, series == self.series,
                      let part = self.parts.firstIndex(where: { $0.data.chapterId == chapter }),
                      self.parts[part].data.images.indices.contains(index) else { return }
                let old = self.parts[part].data.images[index]
                if old.hasMeasuredDimensions && old.width == width && old.height == height { return }
                self.parts[part].data.images[index].width = width
                self.parts[part].data.images[index].height = height
                self.parts[part].data.images[index].dimensionsMeasured = true
                self.publishPages()
            }
        })
        let source = library.chapters
        Task { [weak self] in
            await source.onChapterChange { [weak self] series, chapter in
                Task { @MainActor [weak self] in
                    guard let self, self.series == series, let last = parts.last,
                          let list, let index = list.firstIndex(of: last.data.chapterId), index > 0,
                          list[index - 1] == chapter else { return }
                    if case .loading? = loads[chapter] { return }
                    loads[chapter] = nil; continueReading()
                }
            }
        }
        if !openSaved() { Task { await open() } }
    }

    private func openSaved() -> Bool {
        guard let chapter, let data = library.chapters.files.chapterNow(series, chapter) else { return false }
        show(library.sizedNow(data, series: series))
        Task { [weak self] in
            guard let self else { return }
            if let known = await library.chapters.knownList(series: series) { list = list.map { withNewerChapters(known, $0) } ?? known }
            continueReading()
        }
        return true
    }

    private func open() async {
        let source = library.chapters
        list = await source.knownList(series: series)
        var chapterID = chapter
        if chapterID == nil {
            showMessage("Loading chapters...")
            let oldest: String?
            do { oldest = try await source.oldest(series: series, slug: slug) }
            catch { showMessage("Failed to load chapter list — retrying…", error: true); retryOpening(); return }
            guard let oldest else { showMessage("No chapters available — retrying…", error: true); retryOpening(); return }
            chapterID = oldest; chapter = oldest; stateChanged?()
        }
        guard let chapterID else { return }
        if await source.savedChapter(series: series, chapterId: chapterID) == nil { showMessage("Loading...") }
        var data: ChapterData?
        do { data = try await source.chapter(series: series, slug: slug, chapterId: chapterID, urgent: true) }
        catch { showMessage("Failed to load chapter — retrying…", error: true); retryOpening(); return }
        guard var data else { showMessage("Chapter unavailable — retrying…", error: true); retryOpening(); return }
        data = await library.sized(data, series: series); show(data)
    }

    private func show(_ data: ChapterData) {
        message = nil; loads[data.chapterId] = .loaded
        parts = [Part(data: data, first: 0)]; pages = []; placed = false; documentID += 1
        report(chapter: data.chapterId, page: requestedIndex)
        publishPages(); continueReading(); fetchList()
    }
    private var requestedIndex: Int {
        if let restoring { return restoring.position.index }
        switch start {
        case .last: return max(0, (parts.first?.data.images.count ?? 1) - 1)
        case .image(let index): return max(0, index)
        default: return 0
        }
    }
    private func publishPages() {
        let published = pages.count
        var more: [StripPage] = []
        outer: for part in parts where part.first + part.data.images.count > published {
            for image in part.data.images.dropFirst(max(0, published - part.first)) {
                guard image.hasMeasuredDimensions, let width = image.width, let height = image.height else { break outer }
                more.append(StripPage(key: "page:" + image.url, aspect: CGFloat(width / height)))
            }
        }
        pages.append(contentsOf: more); changed?()
    }
    private func fetchList() {
        guard case .waiting = listFetch else { return }
        listFetch = .loading
        Task {
            do {
                let fresh = try await library.chapters.fetchList(series: series, slug: slug, urgent: true)
                list = list.map { withNewerChapters(fresh, $0) } ?? fresh
                listFetch = .waiting(until: Date().addingTimeInterval(300))
            } catch {
                listFetch = .waiting(until: Date().addingTimeInterval(15)); retryContinuation()
                if list == nil, !parts.isEmpty { showFooter("Failed to load chapter list", error: true) }
            }
            continueReading()
        }
    }
    private func continueReading() {
        guard let first = parts.first, let last = parts.last else { return }
        let current = placed ? viewport().live.flatMap { locate($0.index)?.0 } ?? first : first
        if let list, let index = list.firstIndex(of: last.data.chapterId), index > 0 {
            loadNewer(list[index - 1], allowFetch: current.data.chapterId == last.data.chapterId)
        } else if case .waiting(let until) = listFetch, Date() >= until { fetchList() }
    }
    private func loadNewer(_ chapter: String, allowFetch: Bool) {
        switch loads[chapter] {
        case .loading?, .loaded?: return
        case .unavailable(let until)?, .failed(let until)?: if Date() < until { return }
        case nil: break
        }
        loads[chapter] = .loading
        Task {
            do {
                var data = await library.chapters.savedChapter(series: series, chapterId: chapter)
                if data == nil {
                    guard allowFetch else { loads[chapter] = nil; return }
                    showFooter("Loading newer chapter...")
                    data = try await library.chapters.chapter(series: series, slug: slug, chapterId: chapter, urgent: true)
                }
                if !allowFetch, let data {
                    let names = data.images.map { ImageItem(url: $0.url, cover: false).name }
                    guard await library.images.completed(names).count == names.count else { loads[chapter] = nil; return }
                }
                guard var data else {
                    loads[chapter] = .unavailable(retryAt: Date().addingTimeInterval(15))
                    retryContinuation(); showFooter("Chapter unavailable", error: true); return
                }
                data = await library.sized(data, series: series); loads[chapter] = .loaded
                guard !parts.contains(where: { $0.data.chapterId == chapter }) else { return }
                parts.append(Part(data: data, first: parts.reduce(0) { $0 + $1.data.images.count }))
                footer = nil; publishPages()
                if let position = viewport().live, let (part, page) = locate(position.index) { report(chapter: part.data.chapterId, page: page) }
                continueReading()
            } catch {
                loads[chapter] = .failed(retryAt: Date().addingTimeInterval(15))
                retryContinuation(); showFooter("Failed to load chapter", error: true)
            }
        }
    }
    private func retryOpening() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
            guard let self, parts.isEmpty else { return }; Task { await self.open() }
        }
    }
    private func retryContinuation() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in self?.continueReading() }
    }
    private func report(chapter: String, page: Int) {
        library.reading(self, .init(series: series, slug: slug, chapters: parts.map(\.data.chapterId), chapter: chapter, page: page), visible: visible)
    }
    private func showMessage(_ text: String, error: Bool = false) { message = Message(text: text, error: error); changed?() }
    private func showFooter(_ text: String, error: Bool = false) { footer = Message(text: text, error: error); changed?() }

    var debugState: [String: Any] {
        ["series": series, "chapters": parts.map(\.data.chapterId), "settledChapter": settled?.chapter ?? "",
         "settled": settled.map { ["chapter": $0.chapter, "index": $0.index] } ?? [:], "list": list?.count ?? -1]
    }
}
