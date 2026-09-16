import UIKit
import WebKit

@MainActor
final class WebController: UIViewController, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
    private let store: ReaderStore
    private var webView: WKWebView!
    private var foreground = false
    private var home = true
    private var activeDocument = ""
    private var firstLaunch = true
    private var requests: [String: Task<Data, Error>] = [:]
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
    func capturePosition() { webView?.evaluateJavaScript("window.mangaApp?.save()", completionHandler: nil) }
    func resume() {
        foreground = true; UIApplication.shared.isIdleTimerDisabled = !home
        webView?.evaluateJavaScript("window.mangaApp?.resume()", completionHandler: nil)
    }
    func pause() {
        foreground = false; UIApplication.shared.isIdleTimerDisabled = false
        webView?.evaluateJavaScript("window.mangaApp?.pause()", completionHandler: nil)
        Task { await store.downloader.setActive(false) }
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, message.frameInfo.request.url?.scheme == "asura", message.frameInfo.request.url?.host == "app",
              let body = message.body as? [String: Any], let command = body["command"] as? String,
              let args = body["args"] as? [String: Any], let data = try? jsonData(args),
              let document = body["document"] as? String else { replyHandler(nil, "Invalid reader request"); return }
        if command == "init" || command == "activate" { activeDocument = document }
        guard document == activeDocument else { replyHandler(nil, "Document is no longer active"); return }
        if command == "fetch-cancel" {
            if let id = args["requestID"] as? String { requests[id]?.cancel() }
            replyHandler("{}", nil); return
        }
        if command == "fetch", let id = args["requestID"] as? String {
            let task = Task { try await store.http.fetch(data) }; requests[id] = task
            Task {
                do { replyHandler(String(decoding: try await task.value, as: UTF8.self), nil) }
                catch { replyHandler(nil, error.localizedDescription) }
                requests[id] = nil
            }
            return
        }
        Task {
            do {
                let result: Data
                if command == "init" {
                    var payload = try object(await store.bootstrap())
                    payload["cold"] = firstLaunch; firstLaunch = false
                    result = try jsonData(payload)
                } else if command == "activate" {
                    home = args["home"] as? Bool == true
                    UIApplication.shared.isIdleTimerDisabled = foreground && !home
                    await store.downloader.setActive(foreground)
                    result = Data("{}".utf8)
                } else { result = try await store.command(command, data: data) }
                replyHandler(String(decoding: result, as: UTF8.self), nil)
            } catch { replyHandler(nil, error.localizedDescription) }
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        let allowed = url?.scheme == "asura" && url?.host == "app"
        decisionHandler(allowed ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        activeDocument = ""
        for task in requests.values { task.cancel() }; requests.removeAll()
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        firstLaunch = true; webView.load(URLRequest(url: URL(string: "asura://app/")!))
    }
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
                let (data, mime) = try await store.resource(url)
                guard !Task.isCancelled else { return }
                urlSchemeTask.didReceive(URLResponse(url: url, mimeType: mime, expectedContentLength: data.count, textEncodingName: mime.hasPrefix("text/") ? "utf-8" : nil))
                urlSchemeTask.didReceive(data); urlSchemeTask.didFinish()
            } catch { if !Task.isCancelled { urlSchemeTask.didFailWithError(error) } }
            self?.tasks.removeValue(forKey: id)
        }
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) { tasks.removeValue(forKey: ObjectIdentifier(urlSchemeTask))?.cancel() }
}
