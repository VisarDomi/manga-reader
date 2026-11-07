#if targetEnvironment(simulator)
import UIKit
import KitCore
import KitLists
import KitNavigation
import KitTestHooks

// Uses the production navigation, Home cover action, reader and on-disk state.
// Reset once explicitly; ordinary relaunches must restore the same fixture data.
@MainActor
final class ReaderRestorationChecks: UIViewController {
    private var app: AppController?
    private var nav: LiveNavigationController?
    private weak var hostWindow: UIWindow?
    private var started = false
    private var error = ""
    private let series = "restore-series"
    private let pendingHome = ProcessInfo.processInfo.arguments.contains("-pending-home-check")
    private let gate = RestoreCatalogGate()
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .black
        TestHooks.shared.register("manga-viewport-state") { [self] _ in state }
        TestHooks.shared.register("manga-viewport-action") { [self] query in
            guard let app, let nav else { return state }
            switch query["kind"] {
            case "open":
                if let home = nav.topViewController as? HomeScreen,
                   let table = find(UITableView.self, in: home.view),
                   let cell = table.visibleCells.compactMap({ $0 as? HomeCell }).first(where: { $0.series?.slug == series }) {
                    home.card(cell, opened: .cover)
                } else { error = "Home cover was not ready" }
            case "back": _ = nav.popViewController(animated: false)
            case "forward": nav.goForward(animated: false)
            case "move":
                _ = (nav.topViewController as? ReaderScreen)?.checkViewport(
                    y: query["y"].flatMap(Double.init), scale: query["scale"].flatMap(Double.init),
                    x: query["x"].flatMap(Double.init), end: query["end"] == "1")
            case "home-move":
                if let home = nav.topViewController as? HomeScreen, let table = find(UITableView.self, in: home.view) {
                    home.scrollViewWillBeginDragging(table)
                    table.contentOffset.y = CGFloat(Double(query["y"] ?? "0") ?? 0)
                    home.scrollViewDidEndDragging(table, willDecelerate: false)
                }
            case "release":
                Task { await gate.open(); app.library.refreshCatalog(full: true) }
            case "flush": nav.flush()
            default: break
            }
            return state
        }
        TestHooks.shared.start()
    }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }; started = true; hostWindow = view.window
        Task { do { try await prepare() } catch { self.error = String(describing: error) } }
    }
    private var state: [String: Any] {
        guard let app, let nav else { return ["ready": false,"error": error] }
        let position = app.library.position(series)
        let progress = app.library.state.progress(series)
        return ["ready": nav.view.window != nil, "error": error,
                "screen": nav.topViewController is ReaderScreen ? "reader" : "home",
                "reader": (nav.topViewController as? ReaderScreen)?.checkState ?? [:],
                "progress": progress.map { ["chapter": $0.chapterId, "index": $0.imageIndex] } ?? [:],
                "saved": position.map { ["chapter": $0.chapter,"index": $0.index,"fraction": $0.fraction,
                                          "zoom": $0.zoom?.scale ?? 1] } ?? [:],
                "forward": nav.canGoForward, "catalogComplete": app.library.catalog.complete,
                "homeSaved": (nav.topViewController as? HomeScreen)?.savedState().flatMap { try? JSONSerialization.jsonObject(with: $0) } ?? [:]]
    }
    private func find<T: UIView>(_ type: T.Type, in view: UIView) -> T? {
        if let found = view as? T { return found }
        return view.subviews.lazy.compactMap { self.find(type, in: $0) }.first
    }
    private func prepare() async throws {
        let root = URL.documentsDirectory.appendingPathComponent(pendingHome ? "pending-home-fixture" : "reader-viewport-fixture")
        if ProcessInfo.processInfo.arguments.contains("-reset-viewport-check") { try? FileManager.default.removeItem(at: root) }
        let entry = HomeSeries(slug: series, title: "Restore fixture", coverUrl: "https://restore.invalid/cover.jpg",
                               chapters: ["2","1"].map { HomeChapter(chapterId: $0, label: "Chapter \($0)", locked: false) })
        let others = (0..<10).map { HomeSeries(slug: "other-\($0)", title: "Other \($0)", coverUrl: entry.coverUrl, chapters: []) }
        if !FileManager.default.fileExists(atPath: root.appendingPathComponent("fixture-ready").path) {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            let format = UIGraphicsImageRendererFormat(); format.scale = 1
            let jpeg = UIGraphicsImageRenderer(size: CGSize(width: 320, height: 640), format: format).jpegData(withCompressionQuality: 0.9) { context in
                UIColor.systemTeal.setFill(); context.fill(CGRect(x: 0, y: 0, width: 320, height: 640))
                for y in stride(from: 0, through: 640, by: 40) {
                    UIColor.white.setFill(); context.fill(CGRect(x: 0, y: y, width: 320, height: 2))
                }
                UIColor.systemPink.setFill(); context.fill(CGRect(x: 20, y: 0, width: 4, height: 640))
            }
            try DurableFile.writeJSON(Catalog(series: pendingHome ? others : [entry], complete: !pendingHome), to: root.appendingPathComponent("catalog.json"))
            let files = ChapterFiles(directory: root)
            for chapter in ["1","2"] {
                let images = (0..<12).map { ChapterImage(url: "https://restore.invalid/\(chapter)/\($0).jpg", width: 320, height: 640, dimensionsMeasured: true) }
                await files.save(ChapterData(chapterId: chapter, seriesSlug: series, seriesTitle: entry.title, images: images), series: series)
                for image in images {
                    let file = root.appendingPathComponent(ImageItem(url: image.url, cover: false).name)
                    try DurableFile.write(jpeg, to: file)
                    try DurableFile.write(Data("image/jpeg".utf8), to: file.appendingPathExtension("mime"))
                }
            }
            let cover = root.appendingPathComponent(ImageItem(url: entry.coverUrl, cover: true).name)
            try DurableFile.write(jpeg, to: cover); try DurableFile.write(Data("image/jpeg".utf8), to: cover.appendingPathExtension("mime"))
            await files.saveList(["2","1"], series: series)
            let state = ReadingState(directory: root, provider: "fixture")
            state.save(series: series, chapterId: "1", imageIndex: 0, totalImages: 12); state.flush()
            if pendingHome {
                let saved = try JSONEncoder().encode(HomeScreen.State(anchor: ScrollAnchor(key: series, fraction: 0.43125)))
                let route = try JSONEncoder().encode(Route.home)
                try DurableFile.writeJSON(SavedStack(back: [.init(route: route, state: saved)]), to: root.appendingPathComponent("navigation.json"))
            }
            try DurableFile.write(Data(), to: root.appendingPathComponent("fixture-ready"))
        }
        let app = AppController(checkRoot: root, provider: RestoreProvider(entries: pendingHome ? [entry] + others : [entry], gate: gate, blocked: pendingHome))
        self.app = app
        let nav = app.makeNavigation(); self.nav = nav
        hostWindow?.rootViewController = nav
        nav.view.layoutIfNeeded()
    }
}

private actor RestoreCatalogGate {
    private(set) var released = false
    func open() { released = true }
}

private struct RestoreProvider: MangaProvider {
    let entries: [HomeSeries]
    let gate: RestoreCatalogGate
    let blocked: Bool
    let key = "fixture"
    let origin = URL(string: "https://restore.invalid")!
    func home(_ cursor: String?) async throws -> HomePage {
        let released = await gate.released
        if blocked && !released { throw URLError(.notConnectedToInternet) }
        return HomePage(series: entries, nextCursor: nil)
    }
    func chapter(_ slug: String, _ chapterId: String) async throws -> ChapterData? { throw URLError(.notConnectedToInternet) }
    func chaptersNewestFirst(_ slug: String) async throws -> [String] { ["2","1"] }
}
#endif
