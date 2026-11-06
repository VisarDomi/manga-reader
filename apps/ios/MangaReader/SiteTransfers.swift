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

    func handleEvents(_ callback: Completion, continueDownloads: Bool = true) async {
        let session = session
        await queue.handleEvents(session, callback, continueDownloads: continueDownloads)
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
        enum Mode { case foreground, background }
        enum Connection {
            case disconnected
            case discovering(Task<[URLSessionTask], Never>)
            case connected
        }
        enum Request {
            case idle
            case admitting(Task<Void, Never>)
            case transferring(Pending)
            case completing(Pending)
        }
        let file: URL
        let limiter: RequestLimiter
        var items: [Item]
        var mode = Mode.foreground
        var connection = Connection.disconnected
        var request = Request.idle
        var completion: Completion?
        var generation = 0

        init(file: URL, limiter: RequestLimiter) {
            self.file = file; self.limiter = limiter
            items = (try? DurableFile.readJSON([Item].self, from: file)) ?? []
        }
        func save() throws { try DurableFile.writeJSON(items, to: file) }
        func connect(_ session: URLSession) async {
            let load: Task<[URLSessionTask], Never>
            switch connection {
            case .connected: return
            case .discovering(let running): load = running
            case .disconnected:
                load = Task { await session.allTasks }; connection = .discovering(load)
            }
            let tasks = await load.value
            if case .connected = connection { return }
            connection = .connected
            for task in tasks {
                if case .idle = request, let pending = SiteTransfers.decode(task.taskDescription), pending.ticket != nil {
                    request = .transferring(pending)
                } else { task.cancel() }
            }
        }
        func cancelAdmission() {
            if case .admitting(let task) = request { task.cancel(); request = .idle }
        }
        func handOff(_ items: [Item], session: URLSession) async {
            generation += 1; let revision = generation
            cancelAdmission()
            await connect(session)
            guard generation == revision else { return }
            self.items = items.filter { SiteTransfers.safe($0.file) }
            do { try save() } catch { return }
            mode = .background
            start(session)
        }
        func reclaim(_ session: URLSession) async {
            mode = .foreground; generation += 1; let revision = generation
            cancelAdmission()
            await connect(session)
            guard generation == revision else { return }
            let tasks = await session.allTasks
            guard generation == revision else { return }
            let ticket: RequestLimiter.Ticket?
            if case .transferring(let pending) = request { ticket = pending.ticket; request = .idle }
            else { ticket = nil }
            for task in tasks { task.cancel() }
            if let ticket { await limiter.finish(ticket, cancelled: true) }
            finishEventsIfReady()
        }
        func handleEvents(_ session: URLSession, _ completion: Completion, continueDownloads: Bool) async {
            self.completion = completion
            let revision = generation
            await connect(session)
            guard generation == revision else { finishEventsIfReady(); return }
            mode = continueDownloads ? .background : .foreground
            start(session)
        }
        func eventsFinished(_ session: URLSession) { start(session); finishEventsIfReady() }
        func finishEventsIfReady() {
            switch request { case .admitting, .completing: return; default: break }
            guard let completion else { return }
            self.completion = nil
            DispatchQueue.main.async { completion.call() }
        }
        func start(_ session: URLSession) {
            guard mode == .background, case .idle = request, let item = items.first else { finishEventsIfReady(); return }
            let revision = generation
            let task = Task { [limiter] in
                do {
                    let ticket = try await limiter.acquire(host: item.url.host ?? "", urgency: nil, scheduled: true)
                    self.admitted(item, ticket: ticket, revision: revision, session: session)
                } catch { self.admissionFailed(revision) }
            }
            request = .admitting(task)
        }
        func admitted(_ item: Item, ticket: RequestLimiter.Ticket, revision: Int, session: URLSession) {
            guard mode == .background, generation == revision else {
                Task { await limiter.finish(ticket, cancelled: true) }; return
            }
            let pending = Pending(item: item, ticket: ticket)
            guard let data = try? JSONEncoder().encode(pending) else {
                request = .idle; mode = .foreground
                Task { await limiter.finish(ticket, cancelled: true) }
                finishEventsIfReady(); return
            }
            var download = URLRequest(url: item.url)
            for (name, value) in item.headers { download.setValue(value, forHTTPHeaderField: name) }
            let task = session.downloadTask(with: download)
            task.taskDescription = String(decoding: data, as: UTF8.self)
            task.earliestBeginDate = ticket.scheduled
            request = .transferring(pending)
            task.resume(); finishEventsIfReady()
        }
        func admissionFailed(_ revision: Int) {
            guard generation == revision else { return }
            request = .idle; finishEventsIfReady()
        }
        func finished(_ pending: Pending?, response: HTTPURLResponse?, success: Bool, cancelled: Bool, session: URLSession) async {
            guard let pending, case .transferring(let current) = request,
                  current.item.file == pending.item.file, current.ticket?.id == pending.ticket?.id else { return }
            let revision = generation
            request = .completing(pending)
            if let ticket = pending.ticket { await limiter.finish(ticket, response: response, cancelled: cancelled) }
            request = .idle
            // A newer handoff can still contain this just-committed file. Remove
            // it there too rather than downloading it a second time.
            if success { items.removeAll { $0.file == pending.item.file }; try? save() }
            guard generation == revision else { start(session); return }
            if !success, response?.statusCode != 429 && response?.statusCode != 503 { mode = .foreground }
            start(session)
        }
    }
}
