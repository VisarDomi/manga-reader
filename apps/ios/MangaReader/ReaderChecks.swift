#if targetEnvironment(simulator)
import UIKit
import KitCore
import KitTestHooks

// Real reader + real on-disk cache, with an offline provider. No product data or network.
@MainActor
final class ReaderChecks: UIViewController {
    private var app: AppController?
    private var reader: ReaderScreen?
    private var error: String?
    private var homePrepared = false
    private let requests = ReaderCheckRequests()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        TestHooks.shared.register("reader-check-state") { [weak self] _ in self?.state ?? [:] }
        TestHooks.shared.register("reader-check-bottom") { [weak self] query in
            self?.reader?.checkScrollToEnd(end: query["end"] == "1") ?? [:]
        }
        TestHooks.shared.start()
        Task { await prepare() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        reader?.view.frame = view.bounds
    }

    private var state: [String: Any] {
        ["reader": reader?.checkState ?? [:], "chapterRequests": requests.count,
         "error": error ?? "", "ready": reader != nil, "homePrepared": homePrepared,
         "cachedPages": app.map { (try? FileManager.default.contentsOfDirectory(atPath: $0.root.appendingPathComponent("images").path))?.filter { $0.hasSuffix(".mime") }.count ?? 0 } ?? 0]
    }

    private func prepare() async {
        let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("continuous-reader-fixture")
        do {
            try? FileManager.default.removeItem(at: root)
            try FileManager.default.createDirectory(at: root.appendingPathComponent("images"), withIntermediateDirectories: true)
            let format = UIGraphicsImageRendererFormat(); format.scale = 1
            let jpeg = UIGraphicsImageRenderer(size: CGSize(width: 320, height: 480), format: format).image { context in
                UIColor.systemTeal.setFill(); context.fill(CGRect(x: 0, y: 0, width: 320, height: 480))
                for y in stride(from: 0, through: 480, by: 40) {
                    UIColor.white.setFill(); context.fill(CGRect(x: 0, y: y, width: 320, height: 2))
                }
            }.jpegData(compressionQuality: 0.8)!
            let entries = ["unread-a", "unread-b"].map { HomeSeries(slug: $0, title: $0, coverUrl: "", chapters: []) }
            try DurableFile.writeJSON(Catalog(series: entries, complete: true), to: root.appendingPathComponent("catalog.json"))
            let app = AppController(checkRoot: root, provider: OfflineReaderCheckProvider(requests: requests))
            self.app = app
            await app.library.images.setActive(false)
            var homePages: [ImageItem] = [], outside: [ImageItem] = []
            for entry in entries {
                for number in 1...3 {
                    let image = ChapterImage(url: "https://reader-fixture.invalid/\(entry.slug)/\(number).jpg", width: 999, height: 1)
                    let data = ChapterData(chapterId: String(number), seriesSlug: entry.slug, seriesTitle: entry.title, images: [image])
                    await app.library.chapters.files.save(data, series: entry.slug)
                    let item = ImageItem(url: image.url, cover: false)
                    try DurableFile.write(jpeg, to: app.library.images.url(item))
                    try DurableFile.write(Data("image/jpeg".utf8), to: app.library.images.url(item).appendingPathExtension("mime"))
                    if number < 3 { homePages.append(item) } else { outside.append(item) }
                }
                await app.library.chapters.files.saveList(["3", "2", "1"], series: entry.slug)
            }
            for number in 1...8 {
                let images = (0..<4).map { page in ChapterImage(url: "https://reader-fixture.invalid/\(number)/\(page).jpg", width: 999, height: 1) }
                let data = ChapterData(chapterId: String(number), seriesSlug: "fixture", seriesTitle: "Continuous reader", images: images)
                await app.library.chapters.files.save(data, series: "fixture")
                for image in images {
                    let file = app.library.images.url(ImageItem(url: image.url, cover: false))
                    try DurableFile.write(jpeg, to: file)
                    try DurableFile.write(Data("image/jpeg".utf8), to: file.appendingPathExtension("mime"))
                }
            }
            await app.library.chapters.files.saveList((1...8).reversed().map(String.init), series: "fixture")
            app.library.state.save(series: "fixture", chapterId: "1", imageIndex: 0, totalImages: 4)
            app.library.planSoon()
            for _ in 0..<250 {
                if await app.library.images.state["planned"] == 8 { break }
                try await Task.sleep(for: .milliseconds(20))
            }
            let retained = await app.library.images.completed(homePages.map(\.name))
            let removed = await app.library.images.completed(outside.map(\.name))
            homePrepared = retained.isEmpty && removed.isEmpty && app.library.state.started.count == 1
            let reader = ReaderScreen(app: app, series: "fixture", slug: "fixture", chapter: "1", start: .top, state: nil)
            addChild(reader)
            reader.view.frame = view.bounds
            view.addSubview(reader.view)
            reader.didMove(toParent: self)
            self.reader = reader
        } catch { self.error = String(describing: error) }
    }
}

private final class ReaderCheckRequests: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    var count: Int { lock.withLock { value } }
    func record() { lock.withLock { value += 1 } }
}

private struct OfflineReaderCheckProvider: MangaProvider {
    let requests: ReaderCheckRequests
    let key = "fixture"
    let origin = URL(string: "https://reader-fixture.invalid")!
    func home(_ cursor: String?) async throws -> HomePage { HomePage(series: [], nextCursor: nil) }
    func chapter(_ slug: String, _ chapterId: String) async throws -> ChapterData? {
        requests.record()
        throw URLError(.notConnectedToInternet)
    }
    func chaptersNewestFirst(_ slug: String) async throws -> [String] { throw URLError(.notConnectedToInternet) }
}
#endif
