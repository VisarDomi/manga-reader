#if targetEnvironment(simulator)
import UIKit
import KitTestHooks

@MainActor
final class CPUChecks: UIViewController {
    private let label = UILabel()
    private var result: [String: Any] = ["ready": false]
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        label.textColor = .white; label.numberOfLines = 0; view.addSubview(label)
        TestHooks.shared.register("cpu-work-state") { [weak self] _ in self?.result ?? [:] }
        TestHooks.shared.start()
        Task {
            let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("cpu-workload")
            try? FileManager.default.removeItem(at: root)
            do {
                let args = ProcessInfo.processInfo.arguments
                let count = args.firstIndex(of: "-series-count").flatMap { $0 + 1 < args.count ? Int(args[$0 + 1]) : nil } ?? 100
                let report = try await MangaWorkload.run(root: root, seriesCount: count) { [weak self] in self?.label.text = $0 }
                result = (try JSONSerialization.jsonObject(with: JSONEncoder().encode(report))) as? [String: Any] ?? [:]
                result["ready"] = true
                label.text = "CPU workload complete"
            } catch { result = ["ready": true, "error": String(describing: error)] }
        }
    }
    override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); label.frame = view.bounds.insetBy(dx: 24, dy: 24) }
}
#endif
