import Foundation
import KitCore
import KitNet
import KitLifecycle

// The existing background-session identity is retained. Only one admitted request is
// handed to iOS at a time: earliestBeginDate alone cannot pace a batch after suspension.
// The remaining plan and the limiter's reservations survive termination and reboot.
final class SiteTransfers: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    typealias Item = BackgroundTransfers.Item
    struct Pending: Codable, Sendable { let item: Item; let ticket: RequestLimiter.Ticket? }
    private let root: URL
    private let accept: @Sendable (HTTPURLResponse) -> Bool
    private let committed: @Sendable (Item, HTTPURLResponse) -> Void
    private let queue: TransferQueue
    private let lock = NSLock()
    private var successful = Set<Int>()
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: identifier)
        config.isDiscretionary = false
        config.sessionSendsLaunchEvents = true
        config.httpMaximumConnectionsPerHost = 1
        config.urlCache = nil
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()
    private let identifier: String

    init(identifier: String, root: URL, limiter: RequestLimiter,
         accept: @escaping @Sendable (HTTPURLResponse) -> Bool,
         committed: @escaping @Sendable (Item, HTTPURLResponse) -> Void) {
        self.identifier = identifier; self.root = root
        self.accept = accept; self.committed = committed
        queue = TransferQueue(file: root.appendingPathComponent("background-images.json"), limiter: limiter)
        super.init()
        _ = session
    }

    func handleEvents(_ completion: @escaping () -> Void) {
        let session = session
        Task { await queue.handleEvents(session, Completion(call: completion)) }
    }
    func handOff(_ items: [Item]) async { await queue.handOff(items, session: session) }
    func reclaim() async { await queue.reclaim(session) }

    private static func decode(_ description: String?) -> Pending? {
        guard let description else { return nil }
        let data = Data(description.utf8)
        if let pending = try? JSONDecoder().decode(Pending.self, from: data) { return pending }
        // Pending downloads submitted by the previous app version.
        return (try? JSONDecoder().decode(Item.self, from: data)).map { Pending(item: $0, ticket: nil) }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let pending = Self.decode(downloadTask.taskDescription),
              Self.safe(pending.item.file), let response = downloadTask.response as? HTTPURLResponse, accept(response) else { return }
        do {
            try DurableFile.commit(location, to: root.appendingPathComponent(pending.item.file), expectedSize: pending.item.expectedSize)
            committed(pending.item, response)
            _ = lock.withLock { successful.insert(downloadTask.taskIdentifier) }
        } catch { Log.network.error("Background image: \(error.localizedDescription, privacy: .public)") }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let success = lock.withLock { successful.remove(task.taskIdentifier) != nil }
        let pending = Self.decode(task.taskDescription)
        let cancelled = (error as? URLError)?.code == .cancelled
        let response = task.response as? HTTPURLResponse
        Task { await queue.finished(pending, response: response, success: success, cancelled: cancelled, session: session) }
    }
    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        Task { await queue.eventsFinished(session) }
    }
    private static func safe(_ file: String) -> Bool {
        !file.hasPrefix("/") && !file.isEmpty && !file.split(separator: "/").contains("..")
    }
    struct Completion: @unchecked Sendable { let call: () -> Void }

    private actor TransferQueue {
        let file: URL
        let limiter: RequestLimiter
        var items: [Item]
        var enabled = false
        var admission: Task<Void, Never>?
        var current: Pending?
        var connected = false
        var completion: Completion?
        var generation = 0

        init(file: URL, limiter: RequestLimiter) {
            self.file = file; self.limiter = limiter
            items = (try? DurableFile.readJSON([Item].self, from: file)) ?? []
        }
        func save() throws { try DurableFile.writeJSON(items, to: file) }

        func connect(_ session: URLSession) async {
            guard !connected else { return }
            connected = true
            let tasks = await session.allTasks
            // Cancel the old version's unbudgeted batch before submitting anything new.
            for task in tasks {
                if current == nil, let pending = SiteTransfers.decode(task.taskDescription), pending.ticket != nil {
                    current = pending
                } else { task.cancel() }
            }
        }
        func handOff(_ items: [Item], session: URLSession) async {
            await connect(session)
            self.items = items.filter { SiteTransfers.safe($0.file) }
            do { try save() } catch { return }
            enabled = true
            start(session)
        }
        func reclaim(_ session: URLSession) async {
            enabled = false; generation += 1
            admission?.cancel(); admission = nil
            await connect(session)
            if let ticket = current?.ticket { await limiter.finish(ticket, cancelled: true) }
            current = nil
            for task in await session.allTasks { task.cancel() }
        }
        func handleEvents(_ session: URLSession, _ completion: Completion) async {
            self.completion = completion
            await connect(session)
            enabled = true
            start(session)
        }
        func eventsFinished(_ session: URLSession) {
            start(session)
            finishEventsIfReady()
        }
        func finishEventsIfReady() {
            guard admission == nil, let completion else { return }
            self.completion = nil
            DispatchQueue.main.async { completion.call() }
        }
        func start(_ session: URLSession) {
            guard enabled, current == nil, admission == nil, let item = items.first else { finishEventsIfReady(); return }
            let revision = generation
            admission = Task { [limiter] in
                do {
                    let ticket = try await limiter.acquire(host: item.url.host ?? "", urgency: nil, scheduled: true)
                    self.admitted(item, ticket: ticket, revision: revision, session: session)
                } catch { self.admissionFailed(revision) }
            }
        }
        func admitted(_ item: Item, ticket: RequestLimiter.Ticket, revision: Int, session: URLSession) {
            guard enabled, generation == revision else {
                Task { await limiter.finish(ticket, cancelled: true) }; return
            }
            admission = nil
            let pending = Pending(item: item, ticket: ticket)
            guard let data = try? JSONEncoder().encode(pending) else { return }
            var request = URLRequest(url: item.url)
            for (name, value) in item.headers { request.setValue(value, forHTTPHeaderField: name) }
            let task = session.downloadTask(with: request)
            task.taskDescription = String(decoding: data, as: UTF8.self)
            task.earliestBeginDate = ticket.scheduled
            current = pending
            task.resume()
            finishEventsIfReady()
        }
        func admissionFailed(_ revision: Int) {
            guard generation == revision else { return }
            admission = nil
            finishEventsIfReady()
        }
        func finished(_ pending: Pending?, response: HTTPURLResponse?, success: Bool, cancelled: Bool, session: URLSession) async {
            guard let pending, current?.item.file == pending.item.file,
                  current?.ticket?.id == pending.ticket?.id else { return }
            let revision = generation
            current = nil
            if let ticket = pending.ticket { await limiter.finish(ticket, response: response, cancelled: cancelled) }
            guard generation == revision else { return }
            // Failed bytes stay in the durable plan. A throttle retries only after the
            // common cooldown; permanent errors wait for foreground/background refresh.
            if success { items.removeAll { $0.file == pending.item.file } }
            try? save()
            if !success, response?.statusCode != 429 && response?.statusCode != 503 { enabled = false }
            start(session)
        }
    }
}
