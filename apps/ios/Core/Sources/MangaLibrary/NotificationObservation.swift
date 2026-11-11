import Foundation

// The screen/model owns this registration. Releasing it unregisters the block,
// so old readers do not accumulate work on every later page notification.
public final class NotificationObservation {
    private let token: NSObjectProtocol
    public init(name: Notification.Name, using handler: @escaping @Sendable (Notification) -> Void) {
#if canImport(Darwin)
        token = NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main, using: handler)
#else
        // Linux (logic tests on the PC): corelibs' post enqueues onto a .main observer queue and
        // waits, which deadlocks when a main-actor job posts. Run the observer inline instead.
        token = NotificationCenter.default.addObserver(forName: name, object: nil, queue: nil, using: handler)
#endif
    }
    deinit { NotificationCenter.default.removeObserver(token) }
}
