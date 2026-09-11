import UIKit

@main
@MainActor
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private var browser: WebController?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("AsuraReader")
        let controller = WebController(store: ReaderStore(root: root))
        browser = controller
        let window = UIWindow(frame: UIScreen.main.bounds); window.rootViewController = controller
        self.window = window; window.makeKeyAndVisible()
        return true
    }
    func applicationDidBecomeActive(_ application: UIApplication) { browser?.resume() }
    func applicationWillResignActive(_ application: UIApplication) { browser?.capturePosition() }
    func applicationDidEnterBackground(_ application: UIApplication) { browser?.pause() }
}
