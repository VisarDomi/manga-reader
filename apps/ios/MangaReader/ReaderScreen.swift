import UIKit
import KitCore
import KitImages
import KitNavigation
import KitReader

// Where a reader starts in its chapter.
enum ReaderStart: Codable, Hashable, Sendable {
    case top          // the chapter from its start
    case last         // its last page (a chapter read before)
    case first        // the series' first chapter
    case image(Int)   // that page's top at the top of the screen (resuming)
}

// A series read as one strip: the chapter opened, then each newer chapter appended as the
// reading reaches the last one (never older ones). Saved pages and lists answer at once;
// the site is asked again in the background. Every settled page is the series' progress;
// the screen returns to the exact point after a relaunch.
@MainActor
final class ReaderScreen: UIViewController, LiveScreen, StripReaderDelegate {
    struct State: Codable {
        var chapter: String
        var position: StripPosition
    }

    private struct Part {
        var data: ChapterData
        let first: Int
    }

    private enum Load {
        case loading, loaded
        case unavailable(retryAt: Date)
        case failed(retryAt: Date)
    }

    private let app: AppController
    private let series: String
    private var slug: String
    private var chapter: String?
    private let start: ReaderStart
    private var restoring: State?
    private let strip: StripReaderView
    private let message = UILabel()
    private var parts: [Part] = []
    private var list: [String]?
    private enum ListFetch { case waiting(until: Date), loading }
    private var listFetch = ListFetch.waiting(until: .distantPast)
    private var listLoading: Bool { if case .loading = listFetch { return true }; return false }
    private var listDue: Date {
        if case .waiting(let until) = listFetch { return until }; return .distantFuture
    }
    private var loads: [String: Load] = [:]
    private var settled: (chapter: String, index: Int)?
    private var visible = false
    private var observers: [NotificationObservation] = []
    private var initialGeometryApplied = false

    init(app: AppController, series: String, slug: String, chapter: String?, start: ReaderStart, state: Data?) {
        self.app = app
        self.series = series
        self.slug = slug
        self.chapter = chapter
        self.start = start
        restoring = state.flatMap { try? JSONDecoder().decode(State.self, from: $0) }
        if let restoring { self.chapter = restoring.chapter }
        strip = StripReaderView(pipeline: app.pipeline)
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    var allowsEdgeBack: Bool { !strip.isZoomed }

    // The route follows the chapter on screen, so a relaunch reopens it.
    var route: Data {
        (try? JSONEncoder().encode(Route.reader(series: series, slug: slug, chapter: settled?.chapter ?? chapter, start: start))) ?? Data()
    }

    func savedState() -> Data? {
        guard initialGeometryApplied, let position = strip.savedPosition, let (part, index) = locate(position.index) else {
            return restoring.flatMap { try? JSONEncoder().encode($0) }
        }
        return try? JSONEncoder().encode(State(chapter: part.data.chapterId, position: StripPosition(index: index, fraction: position.fraction, zoom: position.zoom, aspect: position.aspect, point: position.point)))
    }

    func captureState() {
        guard isViewLoaded, !strip.isRestoringPosition, let position = strip.currentPosition else { return }
        savePosition(position)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        strip.delegate = self
        // No guessed page boxes: each published page already has measured geometry.
        strip.placeholderHeight = { _ in 0 }
        strip.locksPageDimensions = true
        view.addSubview(strip)
        message.textColor = UIColor(white: 0.53, alpha: 1)
        message.font = .systemFont(ofSize: 14)
        message.textAlignment = .center
        message.numberOfLines = 0
        view.addSubview(message)
        DebugState.shared.register("reader") { [weak self] in
            guard let self else { return [:] }
            return ["series": series, "chapters": parts.map(\.data.chapterId), "settled": settled.map { ["chapter": $0.chapter, "index": $0.index] } ?? [:],
                    "list": list?.count ?? -1, "strip": strip.state]
        }
        observers.append(NotificationObservation(name: UIApplication.didBecomeActiveNotification) { [weak self] _ in
            // A reader can stay open for days: a list due again is checked on return.
            MainActor.assumeIsolated { self?.continueReading() }
        })
        observers.append(NotificationObservation(name: .pageDimensionsKnown) { [weak self] note in
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
                self.publishGeometry()
            }
        })
        let source = app.library.chapters
        Task { [weak self] in
            await source.onChapterChange { [weak self] series, chapter in
                Task { @MainActor [weak self] in
                    guard let self, self.series == series, let last = parts.last,
                          let list, let index = list.firstIndex(of: last.data.chapterId), index > 0,
                          list[index - 1] == chapter else { return }
                    if case .loading? = loads[chapter] { return }
                    loads[chapter] = nil
                    continueReading()
                }
            }
        }
        if !openSaved() { Task { await open() } }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        strip.frame = view.bounds
        strip.layoutIfNeeded()
        settleInitialPosition()
        message.frame = view.bounds.insetBy(dx: 24, dy: 0)
    }

    // The screen never locks while reading.
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        visible = true
        report(chapter: settled?.chapter ?? chapter ?? "", page: settled?.index ?? requestedIndex)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        UIApplication.shared.isIdleTimerDisabled = true
        visible = true
        report(chapter: settled?.chapter ?? chapter ?? "", page: settled?.index ?? requestedIndex)
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        UIApplication.shared.isIdleTimerDisabled = false
    }

    // Gone back from: its chapters stay while it is kept for going forward, but it is no
    // longer what the downloads follow.
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        visible = false
        report(chapter: settled?.chapter ?? chapter ?? "", page: settled?.index ?? requestedIndex)
    }

    private func show(_ text: String?, error: Bool = false) {
        message.text = text
        message.textColor = error ? UIColor(red: 1, green: 0.42, blue: 0.42, alpha: 1) : UIColor(white: 0.53, alpha: 1)
        message.isHidden = text == nil
    }

    // MARK: opening

    // A chapter already on the phone is laid out at once, before the first frame (a relaunch
    // shows the reader as it was left, not an empty screen while the chapter is read back).
    private func openSaved() -> Bool {
        guard let chapterId = chapter, let saved = app.library.chapters.files.chapterNow(series, chapterId) else { return false }
        show(saved: app.library.sizedNow(saved, series: series))
        Task { [weak self] in
            guard let self else { return }
            if let known = await app.library.chapters.knownList(series: series) { list = list.map { withNewerChapters(known, $0) } ?? known }
            continueReading()
        }
        return true
    }

    private func open() async {
        let source = app.library.chapters
        list = await source.knownList(series: series)
        var chapterId = chapter
        if chapterId == nil {
            // The first chapter rarely changes: a kept list answers at once, else the site's
            // first chapter (without waiting for the whole list where it can say).
            show("Loading chapters...")
            let oldest: String?
            do { oldest = try await source.oldest(series: series, slug: slug) }
            catch { show("Failed to load chapter list — retrying…", error: true); retryOpening(); return }
            guard let oldest else { show("No chapters available — retrying…", error: true); retryOpening(); return }
            chapterId = oldest
            chapter = oldest
            stateChanged()
        }
        guard let chapterId else { return }
        if await source.savedChapter(series: series, chapterId: chapterId) == nil { show("Loading...") }
        var data: ChapterData?
        do { data = try await source.chapter(series: series, slug: slug, chapterId: chapterId, urgent: true) }
        catch { show("Failed to load chapter — retrying…", error: true); retryOpening(); return }
        guard var data else { show("Chapter unavailable — retrying…", error: true); retryOpening(); return }
        data = await app.library.sized(data, series: series)
        show(saved: data)
    }

    private func retryOpening() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
            guard let self, self.parts.isEmpty else { return }
            Task { await self.open() }
        }
    }

    private func retryContinuation() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in self?.continueReading() }
    }

    // The chapter on screen at its place (the saved point, the start asked for), then the list.
    private func show(saved data: ChapterData) {
        let chapterId = data.chapterId
        show(nil)
        loads[chapterId] = .loaded
        parts = [Part(data: data, first: 0)]
        strip.isHidden = true
        strip.setPages([])
        initialGeometryApplied = false
        report(chapter: chapterId, page: requestedIndex)
        publishGeometry()

        // The whole list (for the chapters that follow) once the chapter is on screen.
        continueReading()
        fetchList()
    }

    private var requestedIndex: Int {
        if let restoring { return restoring.position.index }
        switch start {
        case .last: return max(0, (parts.first?.data.images.count ?? 1) - 1)
        case .image(let index): return max(0, index)
        default: return 0
        }
    }

    // Publish a contiguous prefix of exact boxes. Missing metadata never becomes
    // an estimated page; later bytes only extend the tail or fill existing boxes.
    private func publishGeometry() {
        var pages: [StripPage] = []
        let published = strip.pages.count
        outer: for part in parts where part.first + part.data.images.count > published {
            for image in part.data.images.dropFirst(max(0, published - part.first)) {
                guard image.hasMeasuredDimensions, let width = image.width, let height = image.height else { break outer }
                pages.append(StripPage(key: "page:" + image.url, aspect: CGFloat(width / height)))
            }
        }
        if !pages.isEmpty { strip.append(pages) }
        guard !initialGeometryApplied, let first = parts.first else { return }
        let index = min(requestedIndex, max(0, first.data.images.count - 1))
        guard strip.pages.indices.contains(index) else { show("Preparing page dimensions…"); return }
        if let restoring, restoring.chapter == first.data.chapterId {
            strip.scroll(to: StripPosition(index: index, fraction: restoring.position.fraction, zoom: restoring.position.zoom, aspect: restoring.position.aspect, point: restoring.position.point))
        } else {
            switch start {
            case .image, .last: strip.scroll(toTopOf: index)
            default: strip.scroll(to: StripPosition(index: index, fraction: 0))
            }
        }
        initialGeometryApplied = true
        restoring = nil
        strip.isHidden = false
        show(nil)
        settleInitialPosition()
    }

    private func settleInitialPosition() {
        guard initialGeometryApplied, settled == nil, let position = strip.currentPosition else { return }
        settle(at: position)
    }

    private func locate(_ index: Int) -> (Part, Int)? {
        guard let part = parts.last(where: { $0.first <= index }), index - part.first < part.data.images.count else { return nil }
        return (part, index - part.first)
    }

    // MARK: the chapter list

    private func fetchList() {
        guard !listLoading else { return }
        listFetch = .loading
        Task {
            do {
                let fresh = try await app.library.chapters.fetchList(series: series, slug: slug, urgent: true)
                // An answer from an older cache never drops a newer chapter already known.
                list = list.map { withNewerChapters(fresh, $0) } ?? fresh
                listFetch = .waiting(until: Date().addingTimeInterval(300))
            } catch {
                listFetch = .waiting(until: Date().addingTimeInterval(15))
                retryContinuation()
                if list == nil, !parts.isEmpty { strip.setFooter("Failed to load chapter list", color: UIColor(red: 1, green: 0.42, blue: 0.42, alpha: 1)) }
            }
            continueReading()
        }
    }

    // Append from the actual end of the document, independently of the last settled page.
    // A continuous drag can cross several cached chapters without ever reporting a settle.
    private func continueReading() {
        guard let first = parts.first, let last = parts.last else { return }
        let current = initialGeometryApplied ? strip.currentPosition.flatMap { locate($0.index)?.0 } ?? first : first
        if let list, let index = list.firstIndex(of: last.data.chapterId), index > 0 {
            let next = list[index - 1]
            // Consume any cached tail immediately. Only fetching uncached future chapters
            // is limited to the current/next pair; cached content never waits for a scroll.
            loadNewer(next, allowFetch: current.data.chapterId == last.data.chapterId)
        } else if Date() >= listDue { fetchList() }
    }

    private func loadNewer(_ chapterId: String, allowFetch: Bool) {
        switch loads[chapterId] {
        case .loading?, .loaded?: return
        case .unavailable(let retryAt)?, .failed(let retryAt)?: if Date() < retryAt { return }
        case nil: break
        }
        loads[chapterId] = .loading
        Task {
            do {
                var data = await app.library.chapters.savedChapter(series: series, chapterId: chapterId)
                if data == nil {
                    guard allowFetch else { loads[chapterId] = nil; return }
                    strip.setFooter("Loading newer chapter...")
                    data = try await app.library.chapters.chapter(series: series, slug: slug, chapterId: chapterId, urgent: true)
                }
                if !allowFetch, let cached = data {
                    let names = cached.images.map { ImageItem(url: $0.url, cover: false).name }
                    guard await app.library.images.completed(names).count == names.count else { loads[chapterId] = nil; return }
                }
                guard var data else {
                    loads[chapterId] = .unavailable(retryAt: Date().addingTimeInterval(15))
                    retryContinuation()
                    strip.setFooter("Chapter unavailable", color: UIColor(red: 1, green: 0.42, blue: 0.42, alpha: 1))
                    return
                }
                data = await app.library.sized(data, series: series)
                loads[chapterId] = .loaded
                guard !parts.contains(where: { $0.data.chapterId == chapterId }) else { return }
                let first = parts.reduce(0) { $0 + $1.data.images.count }
                parts.append(Part(data: data, first: first))
                strip.setFooter(nil)
                publishGeometry()
                if let position = strip.currentPosition, let (part, page) = locate(position.index) {
                    report(chapter: part.data.chapterId, page: page)
                }
                continueReading()
            } catch {
                loads[chapterId] = .failed(retryAt: Date().addingTimeInterval(15))
                retryContinuation()
                strip.setFooter("Failed to load chapter", color: UIColor(red: 1, green: 0.42, blue: 0.42, alpha: 1))
            }
        }
    }

    private func report(chapter: String, page: Int) {
        app.library.reading(self, Library.Reading(series: series, slug: slug, chapters: parts.map(\.data.chapterId), chapter: chapter, page: page), visible: visible)
    }

    // MARK: strip

    func strip(_ strip: StripReaderView, sourceFor index: Int) -> ImageSource {
        guard let (part, page) = locate(index) else { return .load { throw CancellationError() } }
        let item = ImageItem(url: part.data.images[page].url, cover: false), images = app.library.images
        return .load { try await images.file(item) }
    }

    func strip(_ strip: StripReaderView, localFileFor index: Int) -> URL? {
        guard let (part, page) = locate(index) else { return nil }
        return app.library.images.localFile(ImageItem(url: part.data.images[page].url, cover: false))
    }

    func strip(_ strip: StripReaderView, failureTextFor index: Int, error: Error) -> String? {
        guard !(error is CancellationError), let (part, page) = locate(index) else { return nil }
        let item = ImageItem(url: part.data.images[page].url, cover: false), images = app.library.images
        Task { await images.invalidate(item) }
        return "Retrying image…"
    }

    func strip(_ strip: StripReaderView, settledAt position: StripPosition) {
        FrameMonitor.shared.measure("reader.settle") { settle(at: position) }
    }

    private func settle(at position: StripPosition) {
        savePosition(position)
        stateChanged()
    }

    private func savePosition(_ position: StripPosition) {
        guard initialGeometryApplied else { return }
        guard let (part, index) = locate(position.index) else { return }
        let chapterId = part.data.chapterId
        // The visible reader is authoritative even if another retained screen
        // or a restored backup changed the series' global progress meanwhile.
        app.library.state.save(series: series, chapterId: chapterId, imageIndex: index, totalImages: part.data.images.count)
        if settled?.chapter != chapterId || settled?.index != index {
            settled = (chapterId, index)
            report(chapter: chapterId, page: index)
        }
        app.library.savePosition(Library.Position(chapter: chapterId, index: index, fraction: position.fraction, zoom: position.zoom, aspect: position.aspect, point: position.point), series: series)
    }

    func strip(_ strip: StripReaderView, visibleAt position: StripPosition) {
        guard initialGeometryApplied, let (part, index) = locate(position.index) else { return }
        report(chapter: part.data.chapterId, page: index)
        continueReading()
    }

    func stripNearEnd(_ strip: StripReaderView) {
        if initialGeometryApplied, let position = strip.currentPosition, let (part, index) = locate(position.index) {
            report(chapter: part.data.chapterId, page: index)
        }
        continueReading()
    }

    #if targetEnvironment(simulator)
    func checkViewport(y: Double?, scale: Double?, x: Double?, end: Bool) -> [String: Any] {
        strip.scrollViewWillBeginDragging(strip.scrollView)
        if let scale { strip.scrollView.setZoomScale(CGFloat(scale), animated: false) }
        if let x { strip.scrollView.contentOffset.x = CGFloat(x) }
        if let y { strip.scrollView.contentOffset.y = CGFloat(y) }
        strip.scrollViewDidScroll(strip.scrollView)
        if end { strip.scrollViewDidEndDragging(strip.scrollView, willDecelerate: false) }
        return checkState
    }

    var checkState: [String: Any] {
        ["chapters": parts.map(\.data.chapterId), "settledChapter": settled?.chapter ?? "", "strip": strip.state,
         "height": strip.scrollView.contentSize.height, "offset": strip.scrollView.contentOffset.y,
         "viewport": ["width": strip.bounds.width, "height": strip.bounds.height],
         "aspects": strip.pages.compactMap(\.aspect)]
    }
    func checkScrollToEnd(end: Bool) -> [String: Any] {
        strip.scrollViewWillBeginDragging(strip.scrollView)
        strip.scrollView.contentOffset.y = max(0, strip.scrollView.contentSize.height - strip.bounds.height)
        strip.scrollViewDidScroll(strip.scrollView)
        if end { strip.scrollViewDidEndDragging(strip.scrollView, willDecelerate: false) }
        return checkState
    }
    #endif
}
