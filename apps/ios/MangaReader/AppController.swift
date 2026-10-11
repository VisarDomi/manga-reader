import UIKit
import KitCore
import KitImages
import KitLifecycle
import KitLists
import KitNavigation
import KitNet
import KitReader
import KitTestHooks

// Where a screen is.
enum Route: Codable, Hashable, Sendable {
    case home
    // `series` is the identity, `slug` the URL slug it was opened with, `chapter` nil until
    // the first chapter is known.
    case reader(series: String, slug: String, chapter: String?, start: ReaderStart)
}

// The app: one site (chosen at build time), its catalog, reading progress and downloads
// (Library), the screens, and the PC's Load and Save.
@MainActor
final class AppController {
    static let shared = AppController()

    let library: Library
    let pipeline = ImagePipeline(memoryLimit: 192 << 20, concurrency: 6)
    let pc: PCSave?
    let root: URL
    private(set) var navigation: LiveNavigationController!

    private init() {
        let info = Bundle.main.infoDictionary ?? [:]
        // The web version's folder (Application Support/<product>/shared): its progress,
        // saved chapters and images carry over.
        let product = info["CFBundleName"] as? String ?? "MangaReader"
        root = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support/\(product)/shared")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let origin = (info["ReaderOrigin"] as? String).flatMap(URL.init(string:)) ?? URL(string: "https://asurascans.com/")!
        let cookies = CookieJar(file: root.appendingPathComponent("cookies.json"))
        let http = HTTPClient(.init(referer: origin.absoluteString, cookies: cookies, connectionsPerHost: 8, requestTimeout: 20, resourceTimeout: 90))
        let provider = Providers.make(info["ReaderProvider"] as? String ?? "asurascans", http: http)
        library = Library(provider: provider, root: root, bundleID: Bundle.main.bundleIdentifier ?? "MangaReader")
        pc = PCSave(state: library.state)
    }

    func makeNavigation() -> LiveNavigationController {
        let file = root.appendingPathComponent("navigation.json")
        migrateViews(to: file)
        navigation = LiveNavigationController(file: file, factory: { [unowned self] route, state in screen(route, state: state) },
                                              root: HomeScreen(app: self, state: nil))
        AppLifecycle.shared.onResignActive { [weak self] in
            guard let self else { return }
            navigation.flush()
            library.state.flush()
            library.flushPositions()
            library.handOff()
            DebugState.shared.write(to: root)
        }
        AppLifecycle.shared.onBackground { [weak self] in
            self?.library.paused()
            AppDelegate.scheduleRefresh()
        }
        AppLifecycle.shared.onActive { [weak self] _ in
            guard let self else { return }
            library.resumed()
            library.refreshIfStale()
        }
        DebugState.shared.register("navigation") { [weak self] in
            self?.navigation.screens.compactMap { try? JSONDecoder().decode(Route.self, from: $0.route) }.map { "\($0)" } ?? []
        }
        DebugState.shared.register("library") { [weak self] in self?.library.debugState ?? [:] }
        DebugState.shared.register("pipeline") { [weak self] in self?.pipeline.state ?? [:] }
        #if targetEnvironment(simulator)
        TestHooks.shared.back = { [weak self] in _ = self?.navigation.popViewController(animated: true) }
        TestHooks.shared.forward = { [weak self] in self?.navigation.goForward() }
        TestHooks.shared.register("refresh") { [weak self] query in
            self?.library.refreshCatalog(full: query["full"] == "1"); return ["ok": true]
        }
        TestHooks.shared.register("open") { [weak self] query in
            guard let self, let series = query["series"] else { return ["error": "series"] }
            let start: ReaderStart = query["image"].flatMap(Int.init).map { .image($0) } ?? (query["chapter"] == nil ? .first : .top)
            openReader(series: series, slug: library.slug(series), chapter: query["chapter"], start: start)
            return ["ok": true]
        }
        TestHooks.shared.register("images") { [weak self] _ in
            guard let self else { return [:] }
            let images = library.images
            Task { let state = await images.state; DebugState.shared.register("images") { state } }
            return ["requested": true]
        }
        TestHooks.shared.start()
        #endif
        library.refreshCatalog()
        library.planSoon()
        return navigation
    }

    func screen(_ route: Data, state: Data?) -> (any LiveScreen)? {
        guard let route = try? JSONDecoder().decode(Route.self, from: route) else { return nil }
        switch route {
        case .home: return HomeScreen(app: self, state: state)
        case .reader(let series, let slug, let chapter, let start):
            return ReaderScreen(app: self, series: series, slug: slug, chapter: chapter, start: start, state: state)
        }
    }

    // Reopened at the page it was left on, a series returns to the exact point (as going
    // forward does); otherwise `start`.
    func openReader(series: String, slug: String, chapter: String?, start: ReaderStart) {
        var state: Data?
        if case .image(let index) = start, let chapter, let saved = library.position(series), saved.chapter == chapter, saved.index == index {
            state = try? JSONEncoder().encode(ReaderScreen.State(chapter: chapter, position: StripPosition(index: index, fraction: saved.fraction)))
        }
        navigation.open(ReaderScreen(app: self, series: series, slug: slug, chapter: chapter, start: start, state: state))
    }

    // The first native launch rebuilds what the web version left (views.json): Home at its
    // card and, if a reader was open, that reader at its page above it.
    private func migrateViews(to file: URL) {
        guard !FileManager.default.fileExists(atPath: file.path),
              let data = try? Data(contentsOf: root.appendingPathComponent("views.json")),
              let views = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        let encoder = JSONEncoder()
        var back: [SavedStack.Entry] = []
        var homeState: Data?
        if let home = views["home"] as? [String: Any], let series = home["series"] as? String {
            homeState = try? encoder.encode(HomeScreen.State(anchor: ScrollAnchor(key: series, fraction: 0)))
        }
        back.append(SavedStack.Entry(route: (try? encoder.encode(Route.home)) ?? Data(), state: homeState))
        if let view = views["view"] as? [String: Any], view["home"] as? Bool == false,
           let slug = view["series"] as? String, let chapter = view["chapter"] as? String {
            let index = (view["index"] as? NSNumber)?.intValue ?? 0
            let route = Route.reader(series: library.provider.identity(slug), slug: slug, chapter: chapter, start: .image(index))
            if let data = try? encoder.encode(route) { back.append(SavedStack.Entry(route: data, state: nil)) }
        }
        try? DurableFile.writeJSON(SavedStack(back: back), to: file)
    }
}
