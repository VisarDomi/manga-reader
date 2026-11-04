import Foundation

// The screen/model owns this registration. Releasing it unregisters the block,
// so old readers do not accumulate work on every later page notification.
final class NotificationObservation {
    private let token: NSObjectProtocol
    init(name: Notification.Name, using handler: @escaping @Sendable (Notification) -> Void) {
        token = NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main, using: handler)
    }
    deinit { NotificationCenter.default.removeObserver(token) }
}
