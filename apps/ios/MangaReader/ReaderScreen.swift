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
        let data: ChapterData
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
    private var listLoading = false
    private var listDue = Date.distantPast
    private var loads: [String: Load] = [:]
    private var settled: (chapter: String, index: Int)?
    private var visible = false
    private var observers: [NSObjectProtocol] = []

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
        guard let position = strip.currentPosition, let (part, index) = locate(position.index) else {
            return restoring.flatMap { try? JSONEncoder().encode($0) }
        }
        return try? JSONEncoder().encode(State(chapter: part.data.chapterId, position: StripPosition(index: index, fraction: position.fraction)))
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        strip.delegate = self
        // Pages of unknown size wait at 1000 points (as on the website) until their image says.
        strip.placeholderHeight = { _ in 1000 }
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
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            // A reader can stay open for days: a list due again is checked on return.
            MainActor.assumeIsolated { self?.continueReading() }
        })
        if !openSaved() { Task { await open() } }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        strip.frame = view.bounds
        message.frame = view.bounds.insetBy(dx: 24, dy: 0)
    }

    // The screen never locks while reading.
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        UIApplication.shared.isIdleTimerDisabled = true
        visible = true
        if let settled { report(chapter: settled.chapter, page: settled.index) }
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
        if let settled { report(chapter: settled.chapter, page: settled.index) }
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
            catch { show("Failed to load chapter list", error: true); return }
            guard let oldest else { show("No chapters available", error: true); return }
            chapterId = oldest
            chapter = oldest
            stateChanged()
        }
        guard let chapterId else { return }
        if await source.savedChapter(series: series, chapterId: chapterId) == nil { show("Loading...") }
        let data: ChapterData?
        do { data = try await source.chapter(series: series, slug: slug, chapterId: chapterId, urgent: true) }
        catch { show("Failed to load chapter", error: true); return }
        guard var data else { show("Chapter unavailable", error: true); return }
        data = await app.library.sized(data, series: series)
        show(saved: data)
    }

    // The chapter on screen at its place (the saved point, the start asked for), then the list.
    private func show(saved data: ChapterData) {
        let chapterId = data.chapterId
        show(nil)
        loads[chapterId] = .loaded
        parts = [Part(data: data, first: 0)]
        strip.setPages(pages(data))
        if let restoring, restoring.chapter == chapterId {
            strip.scroll(to: StripPosition(index: min(restoring.position.index, data.images.count - 1), fraction: restoring.position.fraction))
        } else {
            switch start {
            case .top, .first: strip.scroll(to: StripPosition(index: 0, fraction: 0))
            case .last: strip.scroll(toTopOf: data.images.count - 1)
            case .image(let index): strip.scroll(toTopOf: min(max(0, index), data.images.count - 1))
            }
        }
        restoring = nil
        report(chapter: chapterId, page: strip.currentPosition?.index ?? 0)
        // The whole list (for the chapters that follow) once the chapter is on screen.
        fetchList()
        // Settle once laid out (a reader that is never scrolled still counts and continues).
        DispatchQueue.main.async { [weak self] in
            guard let self, let position = strip.currentPosition else { return }
            strip(strip, settledAt: position)
        }
    }

    private func pages(_ data: ChapterData) -> [StripPage] {
        data.images.map { image in
            let aspect = image.width.flatMap { width in image.height.map { height in width > 0 && height > 0 ? CGFloat(width / height) : nil } } ?? nil
            return StripPage(key: "page:" + image.url, aspect: aspect)
        }
    }

    private func locate(_ index: Int) -> (Part, Int)? {
        guard let part = parts.last(where: { $0.first <= index }), index - part.first < part.data.images.count else { return nil }
        return (part, index - part.first)
    }

    // MARK: the chapter list

    private func fetchList() {
        guard !listLoading else { return }
        listLoading = true
        Task {
            do {
                let fresh = try await app.library.chapters.fetchList(series: series, slug: slug, urgent: true)
                // An answer from an older cache never drops a newer chapter already known.
                list = list.map { withNewerChapters(fresh, $0) } ?? fresh
                listDue = Date().addingTimeInterval(300)
            } catch {
                listDue = Date().addingTimeInterval(15)
                if list == nil, !parts.isEmpty { strip.setFooter("Failed to load chapter list", color: UIColor(red: 1, green: 0.42, blue: 0.42, alpha: 1)) }
            }
            listLoading = false
            continueReading()
        }
    }

    // Reading the last chapter held: append the next one, or ask for the list again once due.
    private func continueReading() {
        guard let settled, let last = parts.last, settled.chapter == last.data.chapterId else { return }
        if let list, let index = list.firstIndex(of: settled.chapter), index > 0 {
            loadNewer(list[index - 1])
        } else if Date() >= listDue {
            fetchList()
        }
    }

    private func loadNewer(_ chapterId: String) {
        switch loads[chapterId] {
        case .loading?, .loaded?: return
        case .unavailable(let retryAt)?, .failed(let retryAt)?: if Date() < retryAt { return }
        case nil: break
        }
        loads[chapterId] = .loading
        strip.setFooter("Loading newer chapter...")
        Task {
            do {
                guard var data = try await app.library.chapters.chapter(series: series, slug: slug, chapterId: chapterId, urgent: true) else {
                    loads[chapterId] = .unavailable(retryAt: Date().addingTimeInterval(15))
                    strip.setFooter("Chapter unavailable", color: UIColor(red: 1, green: 0.42, blue: 0.42, alpha: 1))
                    return
                }
                data = await app.library.sized(data, series: series)
                loads[chapterId] = .loaded
                guard !parts.contains(where: { $0.data.chapterId == chapterId }) else { return }
                parts.append(Part(data: data, first: strip.pages.count))
                strip.setFooter(nil)
                strip.append(pages(data))
                report(chapter: settled?.chapter ?? chapterId, page: settled?.index ?? 0)
            } catch {
                loads[chapterId] = .failed(retryAt: Date().addingTimeInterval(15))
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

    func strip(_ strip: StripReaderView, settledAt position: StripPosition) {
        FrameMonitor.shared.measure("reader.settle") { settle(at: position) }
    }

    private func settle(at position: StripPosition) {
        guard let (part, index) = locate(position.index) else { return }
        let chapterId = part.data.chapterId
        if settled?.chapter != chapterId || settled?.index != index {
            settled = (chapterId, index)
            app.library.state.save(series: series, chapterId: chapterId, imageIndex: index, totalImages: part.data.images.count)
            report(chapter: chapterId, page: index)
        }
        app.library.savePosition(Library.Position(chapter: chapterId, index: index, fraction: position.fraction), series: series)
        stateChanged()
        continueReading()
    }

    func stripNearEnd(_ strip: StripReaderView) { continueReading() }
}
