import BackgroundTasks
import UIKit
import KitCore

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    static var repairingCache: Bool { ProcessInfo.processInfo.arguments.contains("-repair-page-cache") }
    static var refreshID: String { (Bundle.main.bundleIdentifier ?? "MangaReader") + ".refresh" }

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // New chapters while the app is away: iOS wakes it now and then (more often the more
        // it is used) to look at the catalog and start their downloads.
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.refreshID, using: .main) { task in
            nonisolated(unsafe) let task = task
            MainActor.assumeIsolated {
                Self.scheduleRefresh()
                var finished = false
                let work = Task { @MainActor in
                    await AppController.shared.library.backgroundRefresh()
                    if !finished { finished = true; task.setTaskCompleted(success: true) }
                }
                task.expirationHandler = {
                    work.cancel()
                    DispatchQueue.main.async { if !finished { finished = true; task.setTaskCompleted(success: false) } }
                }
            }
        }
        return true
    }

    static func scheduleRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: refreshID)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 20 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: nil, sessionRole: session.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }

    // iOS relaunched the app (possibly without a screen) to deliver finished downloads.
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
        AppController.shared.library.handleEvents(completionHandler)
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.overrideUserInterfaceStyle = .dark
        window.backgroundColor = .black
        if AppDelegate.repairingCache {
            let controller = UIViewController()
            let label = UILabel()
            label.text = "Cleaning downloaded pages…"
            label.textColor = .white
            label.textAlignment = .center
            label.numberOfLines = 0
            controller.view = label
            window.rootViewController = controller
            window.makeKeyAndVisible()
            self.window = window
            Task {
                let app = AppController.shared
                let report = await app.library.repairPageCache()
                do {
                    try DurableFile.writeJSON(report, to: app.root.appendingPathComponent("cache-repair.json"))
                    label.text = "Downloaded-page cleanup complete."
                } catch { label.text = error.localizedDescription }
            }
            return
        }
        #if targetEnvironment(simulator)
        if ProcessInfo.processInfo.arguments.contains("-reader-check") {
            window.rootViewController = ReaderChecks()
            window.makeKeyAndVisible()
            self.window = window
            return
        }
        #endif
        window.rootViewController = AppController.shared.makeNavigation()
        window.makeKeyAndVisible()
        self.window = window
    }
}
