import Foundation

protocol ImageTransfer: Sendable {
    func image(_ url: String, to file: URL, referrer: String) async throws -> String
}

// The only image network/cache owner. Preparation and WebKit share the same jobs.
actor ImageDownloader {
    private struct Job {
        let url: String
        let cover: Bool
        var waiters: [UUID: CheckedContinuation<(Data, String), Error>] = [:]
    }
    private let root: URL
    private let transfer: any ImageTransfer
    private let referrer: String
    private var retained = Set<String>(), covers = Set<String>(), retainedKeys = Set<String>()
    private var jobs: [String: Job] = [:]
    private var queue: [String] = []
    private var tasks: [String: Task<Void, Never>] = [:]
    private var preempted = Set<String>()
    private var active = true, pumping = false, scanned = false

    init(root: URL, transfer: any ImageTransfer, referrer: String) {
        self.root = root; self.transfer = transfer; self.referrer = referrer
    }
    private func key(_ url: String, _ cover: Bool) -> String { (cover ? "covers/" : "images/") + fileKey(url) }
    private func file(_ key: String) -> URL { root.appendingPathComponent(key) }
    private func cached(_ key: String) -> Bool {
        FileManager.default.fileExists(atPath: file(key).path) && FileManager.default.fileExists(atPath: file(key).appendingPathExtension("mime").path)
    }
    private func read(_ key: String) throws -> (Data, String) {
        (try Data(contentsOf: file(key), options: .mappedIfSafe), try String(contentsOf: file(key).appendingPathExtension("mime"), encoding: .utf8))
    }
    private func keep(_ job: Job) -> Bool { job.cover ? covers.contains(job.url) : retained.contains(job.url) }
    func image(_ url: String, cover: Bool) async throws -> (Data, String) {
        let key = key(url, cover), id = UUID()
        try Task.checkCancellation()
        if cached(key) { return try read(key) }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                if jobs[key] == nil { jobs[key] = Job(url: url, cover: cover); queue.append(key) }
                jobs[key]!.waiters[id] = continuation
                // Release background connections as soon as visible work arrives.
                for (other, task) in tasks where jobs[other]?.waiters.isEmpty == true {
                    preempted.insert(other); task.cancel()
                }
                pump()
            }
        } onCancel: { Task { await self.cancel(key, id: id) } }
    }
    private func cancel(_ key: String, id: UUID) {
        jobs[key]?.waiters.removeValue(forKey: id)?.resume(throwing: CancellationError())
        discardUnused(); pump()
    }
    func setRetained(_ urls: Set<String>) throws {
        let removed = retained.subtracting(urls), added = urls.subtracting(retained)
        retained = urls; retainedKeys = Set(urls.map { key($0, false) })
        discardUnused()
        enqueue(added, cover: false)
        // File maintenance must not gate chapter metadata or bootstrap replies.
        Task(priority: .utility) {
            for url in removed {
                let key = key(url, false)
                if !retained.contains(url), jobs[key] == nil { remove(key) }
                await Task.yield()
            }
            if !scanned {
                scanned = true
                let entries = (try? FileManager.default.contentsOfDirectory(at: root.appendingPathComponent("images"), includingPropertiesForKeys: nil)) ?? []
                for entry in entries where entry.pathExtension != "mime" {
                    let candidate = "images/" + entry.lastPathComponent
                    if !retainedKeys.contains(candidate), jobs[candidate] == nil { remove(candidate) }
                    await Task.yield()
                }
            }
        }
    }
    func prepareCovers(_ urls: Set<String>) {
        let added = urls.subtracting(covers); covers.formUnion(urls)
        enqueue(added, cover: true)
    }
    func setActive(_ value: Bool) {
        active = value
        if active { enqueue(retained, cover: false); enqueue(covers, cover: true) }
        else { discardUnused() }
    }
    private func enqueue(_ urls: Set<String>, cover: Bool) {
        guard active else { return }
        // No per-file stat scan here: a bounded pump checks cached files later.
        for url in urls.sorted() {
            let key = key(url, cover)
            if jobs[key] == nil { jobs[key] = Job(url: url, cover: cover); queue.append(key) }
        }
        pump()
    }
    private func remove(_ key: String) {
        try? FileManager.default.removeItem(at: file(key))
        try? FileManager.default.removeItem(at: file(key).appendingPathExtension("mime"))
    }
    private func discardUnused() {
        for (key, job) in jobs where job.waiters.isEmpty && (!active || !keep(job)) {
            if let task = tasks[key] { task.cancel() }
            else { jobs[key] = nil; queue.removeAll { $0 == key } }
        }
    }
    private func pump() {
        guard !pumping else { return }
        pumping = true
        Task {
            defer { pumping = false }
            var checked = 0
            while !queue.isEmpty {
                let urgent = queue.firstIndex { !(jobs[$0]?.waiters.isEmpty ?? true) }
                let foregroundRunning = tasks.keys.contains { !(jobs[$0]?.waiters.isEmpty ?? true) }
                if urgent == nil && (foregroundRunning || !active) { return }
                guard tasks.count < (urgent == nil ? 3 : 4) else { return }
                let key = queue.remove(at: urgent ?? 0)
                guard let job = jobs[key] else { continue }
                if cached(key) { finish(key, error: nil) }
                else {
                    tasks[key] = Task { [transfer, referrer] in
                        do {
                            _ = try await transfer.image(job.url, to: file(key), referrer: referrer)
                            finish(key, error: nil)
                        } catch { finish(key, error: error) }
                    }
                }
                checked += 1
                if checked % 16 == 0 { await Task.yield() }
            }
        }
    }
    private func finish(_ key: String, error: Error?) {
        tasks[key] = nil
        guard let job = jobs[key] else { pump(); return }
        if preempted.remove(key) != nil, error != nil, (!job.waiters.isEmpty || (active && keep(job))) {
            queue.append(key); pump(); return
        }
        jobs[key] = nil
        if !job.waiters.isEmpty {
            let result: Result<(Data, String), Error> = Result { if let error { throw error }; return try read(key) }
            for waiter in job.waiters.values { waiter.resume(with: result) }
        }
        if !job.cover && !retained.contains(job.url) { remove(key) }
        pump()
    }
    func diagnostics() -> [String: Int] { ["running": tasks.count, "queued": queue.count, "retained": retained.count, "covers": covers.count] }
}
