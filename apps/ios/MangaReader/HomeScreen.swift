import UIKit
import KitCore
import KitImages
import KitLists
import KitNavigation

// The site's whole catalog, latest updates first, one card per series: the cover (resume)
// and the newest chapters, coloured by where reading stands (read, partly read, locked with
// its countdown), then "First chapter". The phone's copy shows at once; the site is asked
// again in the background (and with a pull) and the cards on screen stay where they are.
@MainActor
final class HomeScreen: UIViewController, LiveScreen, UITableViewDataSource, UITableViewDelegate, UITableViewDataSourcePrefetching, HomeCellDelegate {
    struct State: Codable { var anchor: ScrollAnchor? }

    private let app: AppController
    private let table = UITableView(frame: .zero, style: .plain)
    private let message = UILabel()
    private let footer = HomeFooter()
    private let refresh = UIRefreshControl()
    private var series: [HomeSeries] = []
    private var pendingAnchor: ScrollAnchor?
    private var restored = false
    private var observers: [NSObjectProtocol] = []
    private var countdown: Timer?

    init(app: AppController, state: Data?) {
        self.app = app
        super.init(nibName: nil, bundle: nil)
        pendingAnchor = state.flatMap { try? JSONDecoder().decode(State.self, from: $0) }?.anchor
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    var route: Data { (try? JSONEncoder().encode(Route.home)) ?? Data() }
    func savedState() -> Data? { try? JSONEncoder().encode(State(anchor: currentAnchor ?? pendingAnchor)) }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        table.backgroundColor = .black
        table.separatorStyle = .none
        table.rowHeight = HomeCell.height
        table.estimatedRowHeight = HomeCell.height
        table.contentInsetAdjustmentBehavior = .never
        table.indicatorStyle = .white
        table.dataSource = self
        table.delegate = self
        table.prefetchDataSource = self
        table.register(HomeCell.self, forCellReuseIdentifier: "card")
        refresh.tintColor = UIColor(white: 0.6, alpha: 1)
        refresh.addAction(UIAction { [weak self] _ in self?.app.library.refreshCatalog() }, for: .valueChanged)
        table.refreshControl = refresh
        view.addSubview(table)
        message.textColor = UIColor(white: 1, alpha: 0.65)
        message.font = .systemFont(ofSize: 16)
        message.textAlignment = .center
        message.numberOfLines = 0
        view.addSubview(message)
        footer.pc = app.pc
        footer.onLoaded = { [weak self] in self?.reloadVisible() }
        observers.append(NotificationCenter.default.addObserver(forName: .catalogChanged, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.catalogChanged() }
        })
        // Under a reader, Home waits: it refreshes its cards when it shows again (viewWillAppear),
        // not on every page the reader settles on.
        observers.append(NotificationCenter.default.addObserver(forName: .progressChanged, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { if self?.viewIfLoaded?.window != nil { self?.reloadVisible() } }
        })
        observers.append(NotificationCenter.default.addObserver(forName: .coverChanged, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { if self?.viewIfLoaded?.window != nil { self?.reloadVisible() } }
        })
        DebugState.shared.register("home") { [weak self] in
            guard let self else { return [:] }
            return ["cards": series.count, "offset": table.contentOffset.y, "anchor": currentAnchor.map { ["key": $0.key, "fraction": $0.fraction] } ?? [:]]
        }
        catalogChanged()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        reloadVisible()
        countdown = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.reloadVisible() }
        }
        footer.probe()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        countdown?.invalidate()
        countdown = nil
        saveNow()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let anchor = restored ? currentAnchor : nil
        let widthChanged = table.frame.width != view.bounds.width
        table.frame = view.bounds
        let top = view.safeAreaInsets.top
        if table.contentInset.top != top {
            table.contentInset.top = top
            table.verticalScrollIndicatorInsets.top = top
            if !restored { table.contentOffset.y = -top }
        }
        message.frame = view.bounds.insetBy(dx: 24, dy: 24)
        layoutFooter()
        if widthChanged, let anchor { restore(anchor) }
        restoreIfReady()
    }

    private func layoutFooter() {
        let width = view.bounds.width
        let height = footer.height(for: width, bottomInset: view.safeAreaInsets.bottom)
        if footer.frame.size != CGSize(width: width, height: height) || table.tableFooterView !== footer {
            footer.frame = CGRect(x: 0, y: 0, width: width, height: height)
            table.tableFooterView = footer
        }
    }

    // MARK: contents

    private var shownVersion = -1
    private var catalogWaiting = false
    private var rowsMoving: Bool { table.isTracking || table.isDragging || table.isDecelerating }

    // A newer catalog keeps the cards on screen in place, which sets the offset and would stop a
    // fling dead: one that arrives while a finger or momentum moves the cards waits until they stop.
    private func catalogChanged() {
        let library = app.library
        if restored && rowsMoving && library.catalogVersion != shownVersion {
            if !catalogWaiting { catalogWaiting = true; applyWhenStill() }
            footer.status = statusText(loaded: series.count, total: library.catalog.total, loading: library.refreshing, error: library.catalogError)
            return
        }
        catalogWaiting = false
        if library.catalogVersion != shownVersion || series.isEmpty != library.catalog.series.isEmpty {
            shownVersion = library.catalogVersion
            let anchor = restored ? currentAnchor : nil
            series = library.catalog.series
            table.reloadData()
            table.layoutIfNeeded()
            if let anchor { restore(anchor) }
        }
        if !library.refreshing { refresh.endRefreshing() }
        if series.isEmpty {
            message.text = library.refreshing ? "Loading latest updates…" : library.catalogError.map { "Could not load latest updates: \($0)\nPull down to try again." } ?? ""
            message.isHidden = false
        } else {
            message.isHidden = true
        }
        footer.status = statusText(loaded: series.count, total: library.catalog.total, loading: library.refreshing, error: library.catalogError)
        layoutFooter()
        restoreIfReady()
    }

    private func reloadVisible() {
        for cell in table.visibleCells.compactMap({ $0 as? HomeCell }) {
            if let row = table.indexPath(for: cell)?.row, series.indices.contains(row) { configure(cell, row: row) }
        }
    }

    private func configure(_ cell: HomeCell, row: Int) {
        let entry = series[row]
        let id = app.library.identity(entry)
        cell.configure(entry, progress: app.library.state.progress(id), app: app, delegate: self)
    }

    private func statusText(loaded: Int, total: Int?, loading: Bool, error: String?) -> String {
        let count = total.map { "\(loaded) of \($0)" } ?? "\(loaded)"
        if let error, !loading { return "Loaded \(count) series · could not refresh: \(error)" }
        return loading ? "Loaded \(count) series · loading more…" : "Loaded \(count) series"
    }

    // MARK: table

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { series.count }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        FrameMonitor.shared.measure("home.cell") {
            let cell = tableView.dequeueReusableCell(withIdentifier: "card", for: indexPath) as! HomeCell
            configure(cell, row: indexPath.row)
            return cell
        }
    }

    func tableView(_ tableView: UITableView, prefetchRowsAt indexPaths: [IndexPath]) {}

    func tableView(_ tableView: UITableView, shouldHighlightRowAt indexPath: IndexPath) -> Bool { false }

    // MARK: position

    private var currentAnchor: ScrollAnchor? {
        guard let paths = table.indexPathsForVisibleRows, !paths.isEmpty else { return nil }
        return ScrollAnchoring.anchor(in: table, items: paths.filter { series.indices.contains($0.row) }.map {
            (app.library.identity(series[$0.row]), table.rectForRow(at: $0))
        })
    }

    private func restore(_ anchor: ScrollAnchor) {
        guard let row = series.firstIndex(where: { app.library.identity($0) == anchor.key }) else { return }
        ScrollAnchoring.restore(anchor, in: table, frame: table.rectForRow(at: IndexPath(row: row, section: 0)))
    }

    private func restoreIfReady() {
        // Only once the table has its frame (a restore before layout lands too low).
        guard !restored, table.bounds.height > 0, !series.isEmpty else { return }
        // Straight to the anchor, before the table lays out any rows (no covers decoded for rows
        // at the top that are never shown).
        if let anchor = pendingAnchor, series.contains(where: { app.library.identity($0) == anchor.key }) { restore(anchor) }
        pendingAnchor = nil
        restored = true
    }

    private func saveNow() {
        guard restored else { return }
        stateChanged()
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) { app.pipeline.prioritiesChanged() }
    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) { monitor(true) }
    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate { monitor(false); saveNow(); if catalogWaiting { catalogChanged() } }
    }
    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { monitor(false); saveNow(); if catalogWaiting { catalogChanged() } }

    // Also when the cards stop without a scroll's end (a tap stops a fling).
    private func applyWhenStill() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self, catalogWaiting else { return }
            if rowsMoving { applyWhenStill() } else { catalogChanged() }
        }
    }

    private var monitoring = false
    private func monitor(_ moving: Bool) {
        guard moving != monitoring else { return }
        monitoring = moving
        FrameMonitor.shared.scrolling(moving)
    }

    // MARK: taps

    func card(_ cell: HomeCell, opened target: HomeCell.Target) {
        guard let entry = cell.series else { return }
        saveNow()
        let series = app.library.identity(entry)
        let progress = app.library.state.progress(series)
        switch target {
        case .cover:
            // Partly read: that page. Finished: its last page, so the next chapter follows on.
            // Never started: the first chapter.
            if let progress { app.openReader(series: series, slug: entry.slug, chapter: progress.chapterId, start: .image(progress.imageIndex)) }
            else { app.openReader(series: series, slug: entry.slug, chapter: nil, start: .first) }
        case .first:
            app.openReader(series: series, slug: entry.slug, chapter: nil, start: .first)
        case .chapter(let chapter):
            guard let row = entry.chapters.first(where: { $0.chapterId == chapter }), !row.locked else { return }
            let ids = entry.chapters.map(\.chapterId)
            if let progress, progress.chapterId == chapter {
                app.openReader(series: series, slug: entry.slug, chapter: chapter, start: .image(progress.imageIndex))
            } else if let progress, let saved = ids.firstIndex(of: progress.chapterId), let index = ids.firstIndex(of: chapter), index > saved {
                // Read before the saved chapter: its last page.
                app.openReader(series: series, slug: entry.slug, chapter: chapter, start: .last)
            } else {
                app.openReader(series: series, slug: entry.slug, chapter: chapter, start: .top)
            }
        }
    }
}

// MARK: - A card

@MainActor
protocol HomeCellDelegate: AnyObject {
    func card(_ cell: HomeCell, opened target: HomeCell.Target)
}

enum ChapterLook {
    static let unread = UIColor(red: 0xf4 / 255, green: 0xf4 / 255, blue: 0xf5 / 255, alpha: 1)
    static let read = UIColor(red: 0xa5 / 255, green: 0x92 / 255, blue: 0xf0 / 255, alpha: 1)
    static let partial = UIColor(red: 0xf9 / 255, green: 0x69 / 255, blue: 0xe2 / 255, alpha: 1)
    static let locked = UIColor(red: 0xfb / 255, green: 0xbf / 255, blue: 0x24 / 255, alpha: 1)
}

final class HomeCell: UITableViewCell {
    enum Target { case cover, first, chapter(String) }
    static let height: CGFloat = 200

    private(set) var series: HomeSeries?
    private weak var delegate: HomeCellDelegate?
    private let cover = PressableImage()
    private var rows: [ChapterRow] = []
    private let first = ChapterRow()
    private let empty = UILabel()
    private var ticket: ImageTicket?
    private var coverKey: String?
    private var coverURL: String?

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = .black
        contentView.backgroundColor = .black
        selectionStyle = .none
        cover.imageView.contentMode = .scaleAspectFill
        cover.imageView.clipsToBounds = true
        cover.imageView.layer.cornerRadius = 6
        cover.imageView.backgroundColor = UIColor(white: 0.08, alpha: 1)
        cover.addAction(UIAction { [weak self] _ in self?.open(.cover) }, for: .touchUpInside)
        contentView.addSubview(cover)
        for _ in 0..<5 {
            let row = ChapterRow()
            row.addAction(UIAction { [weak self, weak row] _ in
                if let chapter = row?.chapter { self?.open(.chapter(chapter)) }
            }, for: .touchUpInside)
            rows.append(row)
            contentView.addSubview(row)
        }
        first.show(label: "First chapter", time: "", color: ChapterLook.unread, locked: false)
        first.addAction(UIAction { [weak self] _ in self?.open(.first) }, for: .touchUpInside)
        contentView.addSubview(first)
        empty.text = "No chapters available"
        empty.font = .systemFont(ofSize: 12)
        empty.textColor = UIColor(white: 1, alpha: 0.38)
        contentView.addSubview(empty)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }

    override func prepareForReuse() {
        super.prepareForReuse()
        ticket?.cancel()
        ticket = nil
    }

    private func open(_ target: Target) { delegate?.card(self, opened: target) }

    func configure(_ series: HomeSeries, progress: Progress?, app: AppController, delegate: HomeCellDelegate) {
        self.series = series
        self.delegate = delegate
        let ids = series.chapters.map(\.chapterId)
        let saved = progress.flatMap { ids.firstIndex(of: $0.chapterId) }
        for (index, row) in rows.enumerated() {
            guard series.chapters.indices.contains(index) else { row.isHidden = true; row.chapter = nil; continue }
            let chapter = series.chapters[index]
            row.isHidden = false
            row.chapter = chapter.chapterId
            var color = ChapterLook.unread
            if let saved, let progress {
                if index > saved { color = ChapterLook.read }
                else if index == saved { color = progress.complete ? ChapterLook.read : ChapterLook.partial }
            }
            let time: String
            if chapter.locked {
                color = ChapterLook.locked
                time = chapter.unlockAt.map(HomeFormat.countdown) ?? "Locked"
            } else {
                time = HomeFormat.uploaded(chapter.uploadedAt)
            }
            row.show(label: chapter.label, time: time, color: color, locked: chapter.locked)
        }
        empty.isHidden = !series.chapters.isEmpty
        // A cover the site replaced has a new version: its new bytes take the old image's place
        // once decoded; another series' cover clears the card first.
        let version = app.library.coverVersion(series.coverUrl)
        let key = "cover:" + series.coverUrl + (version > 0 ? "#\(version)" : "")
        if coverKey != key || cover.imageView.image == nil {
            if coverURL != series.coverUrl { cover.imageView.image = nil }
            coverKey = key
            coverURL = series.coverUrl
            ticket?.cancel()
            loadCover(series.coverUrl, key: key, app: app)
        }
        app.library.coverShown(series.coverUrl)
        setNeedsLayout()
    }

    private func loadCover(_ url: String, key: String, app: AppController) {
        guard !url.isEmpty else { return }
        let fit = ImageFit.cover(width: Int(150 * 3), height: Int(200 * 3))
        if let image = app.pipeline.cached(key, fit: fit) { cover.imageView.image = image; return }
        let images = app.library.images, item = ImageItem(url: url, cover: true)
        let request = ImagePipeline.Request(key: key, source: .load { try await images.file(item) }, fit: fit, localFile: images.localFile(item)) { [weak self] in
            guard let self, let window = self.window else { return .infinity }
            let frame = self.convert(self.bounds, to: window)
            return Double(frame.maxY < 0 ? -frame.maxY : frame.minY > window.bounds.height ? frame.minY - window.bounds.height : 0)
        }
        ticket = app.pipeline.load(request) { [weak self] result in
            guard let self, self.coverKey == key else { return }
            self.ticket = nil
            if case .success(let image) = result { self.cover.imageView.image = image }
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let bounds = contentView.bounds
        cover.frame = CGRect(x: 16, y: 0, width: 150, height: Self.height)
        let x: CGFloat = 16 + 150 + 20, width = max(0, bounds.width - x - 16)
        let visible = rows.filter { !$0.isHidden }
        let lines = visible.count + (series?.chapters.isEmpty == true ? 1 : 0) + 1
        var y = (Self.height - (CGFloat(lines) * 21 + CGFloat(max(0, lines - 1)) * 6)) / 2
        for row in visible {
            row.frame = CGRect(x: x, y: y, width: width, height: 21)
            y += 27
        }
        if !empty.isHidden {
            empty.frame = CGRect(x: x, y: y, width: width, height: 21)
            y += 27
        }
        first.frame = CGRect(x: x, y: y, width: width, height: 21)
    }
}

// A cover that dims while pressed.
final class PressableImage: UIControl {
    let imageView = UIImageView()
    override init(frame: CGRect) {
        super.init(frame: frame)
        imageView.isUserInteractionEnabled = false
        addSubview(imageView)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }
    override func layoutSubviews() { super.layoutSubviews(); imageView.frame = bounds }
    override var isHighlighted: Bool { didSet { alpha = isHighlighted ? 0.6 : 1 } }
}

// One chapter line: its label (with a lock when locked) and, on the right, when it came out
// or how long until it unlocks.
final class ChapterRow: UIControl {
    var chapter: String?
    private let label = UILabel()
    private let lock = UIImageView(image: UIImage(systemName: "lock.fill"))
    private let time = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        label.font = .systemFont(ofSize: 14, weight: .medium)
        label.lineBreakMode = .byTruncatingTail
        time.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        time.textAlignment = .right
        lock.tintColor = ChapterLook.locked
        lock.contentMode = .scaleAspectFit
        for view in [label, lock, time] as [UIView] { view.isUserInteractionEnabled = false; addSubview(view) }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }

    func show(label text: String, time: String, color: UIColor, locked: Bool) {
        label.text = text
        label.textColor = color
        self.time.text = time
        self.time.textColor = locked ? ChapterLook.locked : UIColor(white: 1, alpha: 0.6)
        lock.isHidden = !locked
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let timeWidth = time.text?.isEmpty == false ? ceil(time.sizeThatFits(bounds.size).width) : 0
        let available = max(0, bounds.width - timeWidth - (timeWidth > 0 ? 12 : 0) - (lock.isHidden ? 0 : 16))
        let labelWidth = min(available, ceil(label.sizeThatFits(bounds.size).width))
        label.frame = CGRect(x: 0, y: 0, width: labelWidth, height: bounds.height)
        lock.frame = CGRect(x: labelWidth + 5, y: (bounds.height - 11) / 2, width: 11, height: 11)
        time.frame = CGRect(x: bounds.width - timeWidth, y: 0, width: timeWidth, height: bounds.height)
    }

    override var isHighlighted: Bool { didSet { alpha = isHighlighted ? 0.5 : 1 } }
}

enum HomeFormat {
    static func uploaded(_ value: String?) -> String {
        guard let value, !value.trimmingCharacters(in: .whitespaces).isEmpty else { return "" }
        guard let date = SiteDate.parse(value) else { return value }
        let minutes = Int(max(0, Date().timeIntervalSince(date)) / 60)
        if minutes < 1 { return "Just now" }
        if minutes < 60 { return "\(minutes)m ago" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h ago" }
        let days = hours / 24
        if days < 7 { return "\(days)d ago" }
        let weeks = days / 7
        return weeks == 1 ? "last week" : "\(weeks) weeks ago"
    }

    static func countdown(_ unlockAt: String) -> String {
        guard let date = SiteDate.parse(unlockAt) else { return "Locked" }
        let remaining = date.timeIntervalSinceNow
        if remaining <= 0 { return "0m" }
        let hours = Int(remaining / 3600), minutes = Int(remaining.truncatingRemainder(dividingBy: 3600) / 60)
        return hours > 0 ? "\(hours)h \(minutes)m" : "\(minutes)m"
    }
}

// MARK: - The end of the list: the catalog's state and the PC's Load and Save

@MainActor
final class HomeFooter: UIView {
    var pc: PCSave?
    var onLoaded: () -> Void = {}
    var status: String = "" { didSet { statusLabel.text = status } }
    private let statusLabel = UILabel()
    private let load = UIButton(type: .system)
    private let save = UIButton(type: .system)
    private let pcStatus = UILabel()
    private var available = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .black
        statusLabel.font = .systemFont(ofSize: 11)
        statusLabel.textColor = UIColor(white: 1, alpha: 0.45)
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 0
        addSubview(statusLabel)
        for (button, title) in [(load, "Load"), (save, "Save")] {
            button.setTitle(title, for: .normal)
            button.setTitleColor(UIColor(white: 0.53, alpha: 1), for: .normal)
            button.titleLabel?.font = .systemFont(ofSize: 14)
            button.isHidden = true
            addSubview(button)
        }
        load.addAction(UIAction { [weak self] _ in self?.run(load: true) }, for: .touchUpInside)
        save.addAction(UIAction { [weak self] _ in self?.run(load: false) }, for: .touchUpInside)
        pcStatus.font = .systemFont(ofSize: 14)
        pcStatus.textColor = UIColor(white: 0.53, alpha: 1)
        addSubview(pcStatus)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }

    func height(for width: CGFloat, bottomInset: CGFloat) -> CGFloat { 12 + 36 + 8 + 40 + max(bottomInset, 12) }

    override func layoutSubviews() {
        super.layoutSubviews()
        statusLabel.frame = CGRect(x: 24, y: 12, width: bounds.width - 48, height: 36)
        let row = CGRect(x: 0, y: 56, width: bounds.width, height: 40)
        let statusWidth = pcStatus.text?.isEmpty == false ? min(bounds.width - 140, ceil(pcStatus.sizeThatFits(row.size).width)) : 0
        let total = 56 + 56 + (statusWidth > 0 ? 8 + statusWidth : 0)
        var x = (bounds.width - total) / 2
        load.frame = CGRect(x: x, y: row.minY, width: 56, height: 40); x += 56
        save.frame = CGRect(x: x, y: row.minY, width: 56, height: 40); x += 64
        pcStatus.frame = CGRect(x: x, y: row.minY, width: statusWidth, height: 40)
    }

    // The controls show only while the PC answers.
    func probe() {
        guard let pc else { return }
        Task {
            available = await pc.available()
            load.isHidden = !available
            save.isHidden = !available
            pcStatus.isHidden = !available
        }
    }

    private func run(load isLoad: Bool) {
        guard let pc else { return }
        load.isEnabled = false
        save.isEnabled = false
        pcStatus.text = ""
        Task {
            do {
                if isLoad { try await pc.load() } else { try await pc.save() }
                pcStatus.text = isLoad ? "Loaded" : "Saved"
                if isLoad { onLoaded() }
            } catch {
                available = await pc.available()
                load.isHidden = !available
                save.isHidden = !available
                pcStatus.text = available ? error.localizedDescription : ""
            }
            load.isEnabled = true
            save.isEnabled = true
            setNeedsLayout()
        }
    }
}
