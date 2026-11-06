#if targetEnvironment(simulator)
import UIKit
import KitCore
import KitLists
import KitImages
import KitTestHooks

@MainActor
final class CoverChecks: UIViewController {
    private var app: AppController?
    private var urls: [String] = []
    private var ticket: ImageTicket?
    private var error = ""
    private let image = UIImageView()
    private var home: HomeScreen?

    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .black
        image.contentMode = .scaleAspectFit; view.addSubview(image)
        TestHooks.shared.register("cover-check-state") { [weak self] _ in self?.state ?? [:] }
        TestHooks.shared.register("cover-check-repeat") { [weak self] _ in
            guard let self, let app else { return [:] }
            app.covers.setCatalog(urls); app.covers.setVisible([urls[25]])
            return state
        }
        TestHooks.shared.register("cover-check-jump") { [weak self] _ in self?.select(145); return self?.state ?? [:] }
        TestHooks.shared.register("cover-check-home") { [weak self] _ in self?.showHome(); return self?.state ?? [:] }
        TestHooks.shared.start()
        Task { await prepare() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        image.frame = view.bounds.insetBy(dx: 30, dy: 60); home?.view.frame = view.bounds
    }

    private var state: [String: Any] {
        guard let app else { return ["ready": false, "error": error] }
        return ["ready": urls.count == 160, "error": error, "covers": app.covers.state,
                "order": app.covers.preparedOrder.compactMap { urls.firstIndex(of: $0) },
                "cached145": app.covers.cached(urls[145]) != nil, "restoredNow": app.pipeline.restoredNow,
                "files": (try? FileManager.default.contentsOfDirectory(atPath: app.root.appendingPathComponent("covers").path))?.filter { $0.hasSuffix(".mime") }.count ?? 0]
    }

    private func select(_ index: Int) {
        guard let app, urls.indices.contains(index) else { return }
        app.covers.setVisible([urls[index]])
        ticket?.cancel()
        ticket = app.covers.loadVisible(urls[index]) { [weak self] result in
            if case .success(let value) = result { self?.image.image = value }
        }
    }

    private func prepare() async {
        let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("cover-fixture")
        do {
            try? FileManager.default.removeItem(at: root)
            urls = (0..<160).map { "https://cover-fixture.invalid/\($0).jpg" }
            let entries = urls.enumerated().map { HomeSeries(slug: "cover-\($0.offset)", title: "Cover \($0.offset)", coverUrl: $0.element, chapters: []) }
            try DurableFile.writeJSON(Catalog(series: entries, complete: true), to: root.appendingPathComponent("catalog.json"))
            let format = UIGraphicsImageRendererFormat(); format.scale = 1
            let bytes = UIGraphicsImageRenderer(size: CGSize(width: 320, height: 480), format: format).image { context in
                UIColor.systemTeal.setFill(); context.fill(CGRect(x: 0, y: 0, width: 320, height: 480))
                UIColor.white.setFill(); context.fill(CGRect(x: 20, y: 30, width: 280, height: 8))
            }.jpegData(compressionQuality: 0.8)!
            let app = AppController(checkRoot: root, provider: CoverCheckProvider())
            await app.library.images.setActive(false)
            for url in urls {
                let file = app.library.images.url(ImageItem(url: url, cover: true))
                try DurableFile.write(bytes, to: file)
                try DurableFile.write(Data("image/jpeg".utf8), to: file.appendingPathExtension("mime"))
            }
            self.app = app
            app.covers.setCatalog(urls)
            select(25)
            if ProcessInfo.processInfo.arguments.contains("-restore-cover-check") {
                // Exactly one synchronous restore, followed by asynchronous
                // decoding: the old ticket must not cancel its replacement.
                app.pipeline.beginRestore(budget: .leastNonzeroMagnitude, frames: 10_000, timeout: 30)
            }
            app.covers.setActive(true)
        } catch { self.error = String(describing: error) }
    }

    private func showHome() {
        guard let app, home == nil else { return }
        let data = try? JSONEncoder().encode(HomeScreen.State(anchor: ScrollAnchor(key: "cover-147", fraction: 0)))
        let home = HomeScreen(app: app, state: data)
        addChild(home); home.view.frame = view.bounds; view.addSubview(home.view); home.didMove(toParent: self)
        self.home = home
    }
}

private struct CoverCheckProvider: MangaProvider {
    let key = "fixture"
    let origin = URL(string: "https://cover-fixture.invalid")!
    func home(_ cursor: String?) async throws -> HomePage { throw URLError(.notConnectedToInternet) }
    func chapter(_ slug: String, _ chapterId: String) async throws -> ChapterData? { throw URLError(.notConnectedToInternet) }
    func chaptersNewestFirst(_ slug: String) async throws -> [String] { throw URLError(.notConnectedToInternet) }
}
#endif
