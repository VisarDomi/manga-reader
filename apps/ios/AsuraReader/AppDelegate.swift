import UIKit

@main
@MainActor
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private var browser: WebController?
    private var background: BackgroundDownloads?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent(Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as! String)
        let origin = Bundle.main.object(forInfoDictionaryKey: "ReaderOrigin") as! String
        let background = BackgroundDownloads(root: root.appendingPathComponent("shared"), referrer: origin)
        self.background = background
        let controller = WebController(store: ReaderStore(root: root, origin: origin), background: background)
        browser = controller
        let window = UIWindow(frame: UIScreen.main.bounds); window.rootViewController = controller
        self.window = window; window.makeKeyAndVisible()
        return true
    }
    func applicationDidBecomeActive(_ application: UIApplication) { browser?.resume() }
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
        background?.handleEvents(completionHandler)
    }
    func applicationWillResignActive(_ application: UIApplication) { browser?.capturePosition() }
    func applicationDidEnterBackground(_ application: UIApplication) { browser?.pause() }
}
