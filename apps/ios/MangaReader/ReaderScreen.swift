import UIKit
import KitCore
import KitImages
import KitNavigation
import KitReader

// UIKit hosts the viewport; ReadingSession owns the document and its workflow.
@MainActor
final class ReaderScreen: UIViewController, LiveScreen, StripReaderDelegate {
    typealias State = ReadingSession.State
    private let session: ReadingSession
    private let strip: StripReaderView
    private let message = UILabel()
    private var displayedDocument = -1
    private var displayedFooter: ReadingSession.Message?

    init(app: AppController, series: String, slug: String, chapter: String?, start: ReaderStart, state: Data?) {
        let strip = StripReaderView(pipeline: app.pipeline, geometry: .measured)
        self.strip = strip
        session = ReadingSession(library: app.library, series: series, slug: slug, chapter: chapter,
            start: start, state: state) { [weak strip] in
                .init(live: strip?.currentPosition, saved: strip?.savedPosition)
            }
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }
    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    var allowsEdgeBack: Bool { !strip.isZoomed }
    var route: Data { session.route }
    func savedState() -> Data? { session.snapshot() }
    func captureState() { guard isViewLoaded else { return }; session.capture() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        strip.delegate = self
        view.addSubview(strip)
        message.font = .systemFont(ofSize: 14)
        message.textAlignment = .center
        message.numberOfLines = 0
        view.addSubview(message)
        session.changed = { [weak self] in self?.render() }
        session.stateChanged = { [weak self] in self?.stateChanged() }
        DebugState.shared.register("reader") { [weak self] in
            guard let self else { return [:] }
            return session.debugState.merging(["strip": strip.state]) { _, new in new }
        }
        session.startReading()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        strip.frame = view.bounds
        strip.layoutIfNeeded()
        session.didLayout()
        message.frame = view.bounds.insetBy(dx: 24, dy: 0)
    }
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated); session.setVisible(true)
    }
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        UIApplication.shared.isIdleTimerDisabled = true; session.setVisible(true)
    }
    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated); UIApplication.shared.isIdleTimerDisabled = false
    }
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated); session.setVisible(false)
    }

    private func render() {
        if displayedDocument != session.documentID {
            displayedDocument = session.documentID
            strip.isHidden = true; strip.setPages([])
        }
        let more = session.pages.dropFirst(strip.pageCount)
        if !more.isEmpty { strip.append(Array(more)) }
        if displayedFooter != session.footer {
            displayedFooter = session.footer
            strip.setFooter(session.footer?.text, color: color(error: session.footer?.error == true))
        }
        if let placement = session.placement {
            guard placement.index >= 0 && placement.index < strip.pageCount else {
                show(.init(text: "Preparing page dimensions…")); return
            }
            switch placement {
            case .point(let position): strip.scroll(to: position)
            case .top(let index): strip.scroll(toTopOf: index)
            }
            strip.isHidden = false
            session.didPlace()
        }
        show(session.message)
    }
    private func color(error: Bool) -> UIColor {
        error ? UIColor(red: 1, green: 0.42, blue: 0.42, alpha: 1) : UIColor(white: 0.53, alpha: 1)
    }
    private func show(_ value: ReadingSession.Message?) {
        message.text = value?.text; message.textColor = color(error: value?.error == true)
        message.isHidden = value == nil
    }

    func strip(_ strip: StripReaderView, sourceFor index: Int) -> ImageSource { session.source(at: index) }
    func strip(_ strip: StripReaderView, localFileFor index: Int) -> URL? { session.localFile(at: index) }
    func strip(_ strip: StripReaderView, failureTextFor index: Int, error: Error) -> String? { session.failedImage(at: index, error: error) }
    func strip(_ strip: StripReaderView, settledAt position: StripPosition) {
        FrameMonitor.shared.measure("reader.settle") { session.save(position); stateChanged() }
    }
    func strip(_ strip: StripReaderView, visibleAt position: StripPosition) { session.focus(position.index) }
    func stripNearEnd(_ strip: StripReaderView) { session.nearEnd() }

    #if targetEnvironment(simulator)
    func checkViewport(y: Double?, scale: Double?, x: Double?, end: Bool) -> [String: Any] {
        strip.scrollViewWillBeginDragging(strip.testScrollView)
        if let scale { strip.testScrollView.setZoomScale(CGFloat(scale), animated: false) }
        if let x { strip.testScrollView.contentOffset.x = CGFloat(x) }
        if let y { strip.testScrollView.contentOffset.y = CGFloat(y) }
        strip.scrollViewDidScroll(strip.testScrollView)
        if end { strip.scrollViewDidEndDragging(strip.testScrollView, willDecelerate: false) }
        return checkState
    }
    var checkState: [String: Any] {
        session.debugState.merging(["strip": strip.state, "height": strip.testScrollView.contentSize.height,
            "offset": strip.testScrollView.contentOffset.y, "viewport": ["width": strip.bounds.width, "height": strip.bounds.height],
            "aspects": strip.testPageAspects]) { _, new in new }
    }
    func checkScrollToEnd(end: Bool) -> [String: Any] {
        checkViewport(y: Double(max(0, strip.testScrollView.contentSize.height - strip.bounds.height)), scale: nil, x: nil, end: end)
    }
    #endif
}
