import UIKit
import WebKit

@MainActor
final class WebController: UIViewController, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
    private let store: ReaderStore
    private var webView: WKWebView!
    private var foreground = false
    private var home = false
    private var work: Task<Void, Never>?
    private var activeDocument = ""
    private var firstLaunch = true
    init(store: ReaderStore) { self.store = store; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("Unused") }
    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override func viewDidLoad() {
        super.viewDidLoad()
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(LocalFiles(store: store), forURLScheme: "asura")
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "asura")
        config.ignoresViewportScaleLimits = true
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self; webView.isInspectable = true
        webView.allowsBackForwardNavigationGestures = true
        webView.isOpaque = false; webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black; webView.scrollView.contentInsetAdjustmentBehavior = .never
        view.backgroundColor = .black; view.addSubview(webView)
        webView.load(URLRequest(url: URL(string: "asura://app/")!))
    }
    override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); webView.frame = view.bounds }
    func capturePosition() { webView?.evaluateJavaScript("window.readerState?.save()", completionHandler: nil) }
    func resume() {
        foreground = true; UIApplication.shared.isIdleTimerDisabled = !home; startWork()
        webView?.evaluateJavaScript("window.readerState?.probePC()", completionHandler: nil)
    }

    func pause() {
        capturePosition(); foreground = false; UIApplication.shared.isIdleTimerDisabled = false; work?.cancel()
        Task { [store] in await store.setHome(false) }
    }
    private func startWork() {
        guard foreground, home, work == nil else { return }
        work = Task { [weak self, store] in
            await store.setHome(true)
            try? await store.refreshCatalog()
            guard let self else { return }
            if !Task.isCancelled, home, foreground { await updateHome(); await store.prepareHome() }
            work = nil
            if Task.isCancelled, home, foreground { startWork() }
        }
    }
    private func updateHome() async {
        guard home, let json = try? await store.snapshot() else { return }
        webView.callAsyncJavaScript("window.readerState?.update(JSON.parse(json))", arguments: ["json": json], in: nil, in: .page, completionHandler: nil)
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, message.frameInfo.request.url?.scheme == "asura", message.frameInfo.request.url?.host == "app",
              let body = message.body as? [String: Any], let command = body["command"] as? String,
              let args = body["args"] as? [String: Any], let data = try? jsonData(args) else { replyHandler(nil, "Invalid reader request"); return }
        let document = body["document"] as? String ?? ""
        Task {
            do {
                try await store.load()
                if command == "init" {
                    activeDocument = document
                    home = message.frameInfo.request.url?.path == "/"
                    await store.setHome(home && foreground)
                    var payload = try object(Data(await store.snapshot().utf8))
                    if firstLaunch {
                        firstLaunch = false
                        let position = await store.lastView()
                        if position.path != "/" { payload["resumeReader"] = position.path }
                    }
                    replyHandler(try jsonText(payload), nil)
                } else if command == "ready" {
                    home = args["home"] as? Bool == true
                    UIApplication.shared.isIdleTimerDisabled = foreground && !home
                    await store.setHome(home && foreground)
                    if home { startWork() } else { work?.cancel() }
                    replyHandler("{}", nil)
                } else {
                    guard document == activeDocument else { replyHandler("{}", nil); return }
                    let result = try await store.webReply(command, data: data)
                    replyHandler(result, nil)
                    if command == "pc-load" { work?.cancel(); await store.setHome(false); await work?.value; work = nil; startWork() }
                }
            } catch { replyHandler(nil, error.localizedDescription) }
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        let allowed = url?.scheme == "asura" && url?.host == "app"
        if allowed, navigationAction.targetFrame?.isMainFrame == true {
            home = false; work?.cancel(); Task { [store] in await store.setHome(false) }
        }
        decisionHandler(allowed ? .allow : .cancel)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { firstLaunch = true; webView.load(URLRequest(url: URL(string: "asura://app/")!)) }
}

@MainActor
final class LocalFiles: NSObject, WKURLSchemeHandler {
    let store: ReaderStore
    private var tasks: [ObjectIdentifier: Task<Void, Never>] = [:]
    init(store: ReaderStore) { self.store = store }
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let id = ObjectIdentifier(urlSchemeTask)
        guard let url = urlSchemeTask.request.url else { return }
        tasks[id] = Task { [store, weak self] in
            do {
                let result = try await store.localResource(url)
                guard !Task.isCancelled else { return }
                urlSchemeTask.didReceive(URLResponse(url: url, mimeType: result.mime, expectedContentLength: result.data.count, textEncodingName: result.mime.hasPrefix("text/") ? "utf-8" : nil))
                urlSchemeTask.didReceive(result.data); urlSchemeTask.didFinish()
            } catch { if !Task.isCancelled { urlSchemeTask.didFailWithError(error) } }
            self?.tasks.removeValue(forKey: id)
        }
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) { tasks.removeValue(forKey: ObjectIdentifier(urlSchemeTask))?.cancel() }
}
