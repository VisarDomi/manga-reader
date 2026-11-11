#if targetEnvironment(simulator)
import UIKit
import KitCore
import KitNavigation
import KitTestHooks
@testable import MangaLibrary
@testable import MangaSources

// Actual UIKit transitions and the durable stack; no provider, media or product data.
@MainActor
final class NavigationChecks: UIViewController {
    private var nav: LiveNavigationController!
    private weak var hostWindow: UIWindow?
    private var started = false
    private var report: [String: Any] = ["complete": false]
    override func viewDidLoad() {
        super.viewDidLoad()
        TestHooks.shared.register("navigation-machine-state") { [self] _ in report }
        TestHooks.shared.start()
    }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }; started = true; hostWindow = view.window
        Task { do { try await run(); report["pass"] = true } catch {
            report["error"] = String(describing: error)
            report["screens"] = names
            report["canGoForward"] = nav?.canGoForward ?? false
            report["transitionActive"] = nav?.transitionCoordinator != nil
            report["windowAttached"] = nav?.view.window != nil
        }; report["complete"] = true }
    }
    override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); nav?.view.frame = view.bounds }
    private struct Failure: Error { let message: String }
    private func check(_ value: Bool, _ message: String) throws { if !value { throw Failure(message: message) } }
    private var names: [String] { nav.screens.map { String(decoding: $0.route, as: UTF8.self) } }
    private func attach(_ file: URL) {
        nav = LiveNavigationController(file: file, factory: { route, state in CheckScreen(String(decoding: route, as: UTF8.self), state: state) }, root: CheckScreen("A"))
        hostWindow?.rootViewController = nav
        nav.view.layoutIfNeeded()
    }
    private func pan(_ state: UIGestureRecognizer.State, progress: CGFloat, velocity: CGFloat = 0) {
        let pan = ScriptedEdgePan(); pan.state = state; pan.x = -view.bounds.width * progress; pan.speed = -velocity
        nav.perform(NSSelectorFromString("forwardPanned:"), with: pan)
    }
    private func wait(_ label: String, until predicate: () -> Bool) async throws {
        for _ in 0..<300 {
            if predicate() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw Failure(message: "UIKit transition timed out: " + label)
    }
    private func settled() async throws {
        try await wait("settle") { self.nav.view.window != nil && self.nav.transitionCoordinator == nil }
        await Task.yield()
    }
    private func run() async throws {
        let file = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("navigation-state-fixture.json")
        try? FileManager.default.removeItem(at: file)
        attach(file)
        try await settled()
        nav.open(CheckScreen("B", state: Data("position-42".utf8)), animated: false)
        nav.open(CheckScreen("C"), animated: false)
        _ = nav.popToRootViewController(animated: false)
        try check(names == ["A"] && nav.canGoForward, "Pop-to-root must keep ordered forward history")
        try await settled()
        pan(.began, progress: 0)
        try await wait("interactive begin") { self.nav.transitionCoordinator?.isInteractive == true }
        nav.goForward() // Must not consume C during B's interactive transition.
        pan(.changed, progress: 0.08); pan(.ended, progress: 0.08)
        try await settled()
        try check(names == ["A"] && nav.canGoForward, "Cancelled forward must restore B exactly once")
        nav.goForward(animated: false)
        try check(names == ["A", "B"], "Forward after cancellation must still visit B")
        try check(nav.screens.last?.savedState() == Data("position-42".utf8), "Live screen state was lost")
        nav.flush(); attach(file)
        try await settled()
        try check(names == ["A", "B"] && nav.canGoForward, "Durable reload must retain both directions")
        nav.goForward(animated: false)
        try check(names == ["A", "B", "C"], "Restored forward history must visit C once")
        _ = nav.popToRootViewController(animated: false)
        try await settled()
        pan(.began, progress: 0)
        try await wait("interactive finish begin") { self.nav.transitionCoordinator?.isInteractive == true }
        pan(.changed, progress: 0.8); pan(.ended, progress: 0.8)
        try await settled()
        try check(names == ["A", "B"], "Completed interactive forward must visit B")
        let screen = nav.topViewController as! CheckScreen
        screen.edgeBack = false
        try check(nav.gestureRecognizerShouldBegin(nav.interactivePopGestureRecognizer!) == false, "A zoomed reader must retain the back edge")
        nav.open(CheckScreen("D"), animated: false)
        try check(!nav.canGoForward && names == ["A", "B", "D"], "New navigation must clear the forward branch")
        nav.flush()
        report = ["complete": false, "screens": names, "cancelledForward": true, "completedForward": true, "durableRestore": true, "zoomEdge": true]
    }
}
@MainActor private final class CheckScreen: UIViewController, LiveScreen {
    let name: String
    let snapshot: Data?
    var edgeBack = true
    var route: Data { Data(name.utf8) }
    var allowsEdgeBack: Bool { edgeBack }
    func savedState() -> Data? { snapshot }
    init(_ name: String, state: Data? = nil) { self.name = name; snapshot = state; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("unused") }
    override func viewDidLoad() {
        super.viewDidLoad(); view.backgroundColor = .black
        let label = UILabel(frame: CGRect(x: 30, y: 80, width: 300, height: 80)); label.textColor = .white; label.text = "Navigation " + name; view.addSubview(label)
    }
}
@MainActor private final class ScriptedEdgePan: UIScreenEdgePanGestureRecognizer {
    private var phase = UIGestureRecognizer.State.possible
    var x: CGFloat = 0
    var speed: CGFloat = 0
    override var state: UIGestureRecognizer.State { get { phase } set { phase = newValue } }
    override func translation(in view: UIView?) -> CGPoint { CGPoint(x: x, y: 0) }
    override func velocity(in view: UIView?) -> CGPoint { CGPoint(x: speed, y: 0) }
}
#endif
