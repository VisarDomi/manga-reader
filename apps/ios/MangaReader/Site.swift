import Foundation
import KitCore
import KitNet

// Shared by queued metadata and image work; promotion never restarts a transfer.
final class Urgency: @unchecked Sendable {
    private let lock = NSLock()
    private var rank: Int
    private var listeners: [UUID: @Sendable () -> Void] = [:]
    init(_ urgent: Bool, priority: Int = 1) { rank = urgent ? priority : 0 }
    var priority: Int { lock.withLock { rank } }
    var value: Bool { priority > 0 }
    func raise(to priority: Int = 1) {
        let callbacks = lock.withLock { () -> [@Sendable () -> Void] in
            guard priority > rank else { return [] }
            rank = priority
            return Array(listeners.values)
        }
        for callback in callbacks { callback() }
    }
    func observe(_ id: UUID, _ callback: @escaping @Sendable () -> Void) {
        lock.withLock { listeners[id] = callback }
    }
    func removeObserver(_ id: UUID) { _ = lock.withLock { listeners.removeValue(forKey: id) } }
}

// One gate for API/HTML, images, cover validation and background URLSession work.
// Retries re-enter the gate; URLSession never retries outside the provider's budget.
struct SiteClient: Sendable {
    @TaskLocal static var urgency: Urgency?
    let http: HTTPClient
    let limiter: RequestLimiter
    private static let observedStatuses: Set<Int> = [403, 408, 429, 500, 502, 503, 504]

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        let policy = request.retry ?? (["GET", "HEAD"].contains(request.method) ? .reads : .never)
        var once = request
        once.retry = .never
        once.accept.formUnion(Self.observedStatuses)
        let urgency = Self.urgency
        return try await policy.run {
            let ticket = try await limiter.acquire(host: request.url.host ?? "", urgency: urgency)
            let response: HTTPResponse
            do { response = try await http.send(once) }
            catch { await limiter.finish(ticket); throw error }
            await limiter.finish(ticket, response: response.response)
            guard (200..<300).contains(response.status) || request.accept.contains(response.status) else {
                throw HTTPStatusError(status: response.status, url: response.url,
                                      retryAfter: SiteResponse.retryAfter(response.response), body: response.data)
            }
            return response
        }
    }

    private struct RejectedDownload: Error { let response: HTTPURLResponse }

    func download(_ request: HTTPRequest, to file: URL,
                  validate: @escaping @Sendable (HTTPURLResponse) throws -> Void) async throws -> HTTPURLResponse {
        let policy = request.retry ?? .reads
        var once = request
        once.retry = .never
        once.accept.formUnion(Self.observedStatuses)
        let urgency = Self.urgency
        return try await policy.run {
            let ticket = try await limiter.acquire(host: request.url.host ?? "", urgency: urgency)
            do {
                let response = try await http.download(once, to: file) { response in
                    guard (200..<300).contains(response.statusCode) || request.accept.contains(response.statusCode) else {
                        throw RejectedDownload(response: response)
                    }
                    try validate(response)
                }
                await limiter.finish(ticket, response: response)
                return response
            } catch let error as RejectedDownload {
                await limiter.finish(ticket, response: error.response)
                throw HTTPStatusError(status: error.response.statusCode, url: error.response.url,
                                      retryAfter: SiteResponse.retryAfter(error.response))
            } catch {
                await limiter.finish(ticket)
                throw error
            }
        }
    }
}

enum SiteResponse {
    static func seconds(_ value: String?) -> Double? {
        guard let text = value?.split(separator: ";").first?.trimmingCharacters(in: .whitespaces),
              let seconds = Double(text), seconds.isFinite, seconds >= 0 else { return nil }
        return seconds
    }

    static func retryAfter(_ response: HTTPURLResponse, now: Date = Date()) -> Double? {
        let value = response.value(forHTTPHeaderField: "Retry-After")
        if let seconds = seconds(value) { return seconds }
        guard let value else { return nil }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        return formatter.date(from: value).map { max(0, $0.timeIntervalSince(now)) }
    }

    static func reset(_ response: HTTPURLResponse, now: Date) -> Date? {
        if let seconds = seconds(response.value(forHTTPHeaderField: "RateLimit-Reset")) {
            return now.addingTimeInterval(seconds)
        }
        if let seconds = seconds(response.value(forHTTPHeaderField: "X-RateLimit-Reset")) {
            return seconds > 1_000_000_000 ? Date(timeIntervalSince1970: seconds) : now.addingTimeInterval(seconds)
        }
        return nil
    }
}

actor RequestLimiter {
    struct Budget: Sendable {
        var limit: Int
        var background: Int
        var spacing: TimeInterval = 0
        var concurrent: Int = 4
        var backgroundConcurrent: Int = 2
        var window: TimeInterval = 60
        static let standard = Budget(limit: 90, background: 50, spacing: 0.5, concurrent: 3, backgroundConcurrent: 2)
        static let media = Budget(limit: 120, background: 90, spacing: 0.3, concurrent: 3, backgroundConcurrent: 2)

        static func media(_ host: String) -> Budget {
            switch host {
            case "media.luacomic.org", "cdn.asurascans.com", "media.qimanga.com", "i1.wp.com":
                return Budget(limit: 210, background: 189, spacing: 0.25, concurrent: 3, backgroundConcurrent: 2)
            case "media.ezmanga.org":
                return Budget(limit: 160, background: 144, spacing: 0.35, concurrent: 3, backgroundConcurrent: 2)
            default: return .media
            }
        }

        // Ez/Qi: measured 60 per 30 seconds; allow 57 with a reader reserve.
        // Other ceilings stay below bounded live throughput, not invented quotas.
        // Headers and throttles can lower them; healthy traffic recovers gradually.
        static func provider(_ key: String) -> Budget {
            switch key {
            case "qimanga", "ezmanga": return Budget(limit: 57, background: 51, spacing: 0.5, concurrent: 2, backgroundConcurrent: 1, window: 30)
            case "luacomic": return Budget(limit: 150, background: 135, spacing: 0.4, concurrent: 2, backgroundConcurrent: 1)
            case "violetscans": return Budget(limit: 150, background: 135, spacing: 0.4, concurrent: 2, backgroundConcurrent: 1)
            case "scythescans": return Budget(limit: 72, background: 64, spacing: 0.8, concurrent: 2, backgroundConcurrent: 1)
            case "yakshacomics": return Budget(limit: 96, background: 86, spacing: 0.6, concurrent: 2, backgroundConcurrent: 1)
            case "asurascans": return Budget(limit: 150, background: 135, spacing: 0.4, concurrent: 3, backgroundConcurrent: 2)
            default: return .standard
            }
        }
    }

    struct Ticket: Sendable, Codable { let id: UUID; let host: String; var scheduled: Date? = nil }
    private struct Host: Codable, Equatable {
        var sent: [Date] = []
        var nextStart: Date = .distantPast
        var blocked: Date = .distantPast
        var ceiling: Int?
        var strikes = 0
        var lastThrottle: Date = .distantPast
        var advertisedCeiling: Int?
        var lastRecovery: Date?
    }
    private struct Waiter {
        let ticket: Ticket
        let urgency: Urgency?
        let scheduled: Bool
        let continuation: CheckedContinuation<Ticket, Error>
    }
    private let budget: Budget
    private let provider: String?
    private let file: URL?
    private var hosts: [String: Host]
    private var running: [UUID: String] = [:]
    private var backgroundRunning = Set<UUID>()
    private var waiting: [Waiter] = []
    private var wake: Task<Void, Never>?
    private var journalWrites = 0

    init(_ budget: Budget, provider: String? = nil, file: URL? = nil) {
        self.budget = budget
        self.provider = provider
        self.file = file
        hosts = file.flatMap { try? DurableFile.readJSON([String: Host].self, from: $0) } ?? [:]
    }

    // API and website share a provider budget; an independent image CDN has its own.
    // Violet's covers/pages on its origin therefore spend the same quota as its AJAX.
    private func key(_ host: String) -> String {
        guard let provider else { return host.lowercased() }
        let domains: [String: [String]] = [
            "luacomic": ["luacomic.org", "api.luacomic.org", "www.luacomic.org"],
            "violetscans": ["violetmanga.com", "www.violetmanga.com", "violetscans.org"],
            "qimanga": ["qimanga.com", "api.qimanga.com"],
            "ezmanga": ["ezmanga.org", "vapi.ezmanga.org"],
            "asurascans": ["asurascans.com", "api.asurascans.com"],
            "scythescans": ["scythescans.com", "www.scythescans.com"],
            "yakshacomics": ["yakshacomics.com", "www.yakshacomics.com"]
        ]
        return domains[provider]?.contains(host.lowercased()) == true ? "site:" + provider : host.lowercased()
    }

    private func policy(_ host: String) -> Budget {
        provider == nil || host.hasPrefix("site:") ? budget : .media(host)
    }

    func acquire(host: String, urgency: Urgency?, scheduled: Bool = false) async throws -> Ticket {
        let ticket = Ticket(id: UUID(), host: key(host))
        try Task.checkCancellation()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                waiting.append(Waiter(ticket: ticket, urgency: urgency, scheduled: scheduled, continuation: continuation))
                urgency?.observe(ticket.id) { [weak self] in Task { await self?.pump() } }
                pump()
            }
        } onCancel: { Task { await self.cancel(ticket.id) } }
    }

    private func cancel(_ id: UUID) {
        guard let index = waiting.firstIndex(where: { $0.ticket.id == id }) else { return }
        let waiter = waiting.remove(at: index)
        waiter.urgency?.removeObserver(id)
        waiter.continuation.resume(throwing: CancellationError())
        pump()
    }

    // Persist admission before issuing the request, including requests handed to iOS.
    private func save() throws {
        if let file { try DurableFile.writeJSON(hosts, to: file); journalWrites += 1 }
    }

    private func pump() {
        wake?.cancel(); wake = nil
        let now = Date()
        var next: Date?
        let ordered = waiting.enumerated().sorted {
            let left = $0.element.urgency?.priority ?? 0, right = $1.element.urgency?.priority ?? 0
            return left == right ? $0.offset < $1.offset : left > right
        }.map(\.element)
        for waiter in ordered {
            let host = waiter.ticket.host, urgent = waiter.urgency?.value == true
            let policy = policy(host)
            var state = hosts[host] ?? Host()
            state.sent.removeAll { now.timeIntervalSince($0) >= policy.window }
            let ceiling = max(1, min(policy.limit, state.ceiling ?? policy.limit))
            let allowed = urgent ? ceiling : max(1, min(policy.background, ceiling * policy.background / max(1, policy.limit)))
            let active = running.values.filter { $0 == host }.count
            let background = running.filter { $0.value == host && backgroundRunning.contains($0.key) }.count
            guard active < policy.concurrent, urgent || background < policy.backgroundConcurrent else { continue }
            // Reserve the next available slot for a waiting screen request on this origin.
            if !urgent && waiting.contains(where: { $0.ticket.host == host && $0.urgency?.value == true }) { continue }
            var ready = max(state.blocked, state.nextStart)
            if state.sent.count >= allowed { ready = max(ready, state.sent[state.sent.count - allowed].addingTimeInterval(policy.window)) }
            if ready > now && !waiter.scheduled {
                next = min(next ?? ready, ready)
                continue
            }
            let admitted = waiter.scheduled ? max(now, ready) : now
            state.sent.append(admitted)
            state.sent.sort()
            state.nextStart = admitted.addingTimeInterval(max(policy.spacing, policy.window / Double(ceiling)))
            var ticket = waiter.ticket
            if waiter.scheduled { ticket.scheduled = admitted }
            hosts[host] = state
            waiting.removeAll { $0.ticket.id == waiter.ticket.id }
            waiter.urgency?.removeObserver(waiter.ticket.id)
            do {
                try save()
                running[waiter.ticket.id] = host
                if !urgent { backgroundRunning.insert(waiter.ticket.id) }
                waiter.continuation.resume(returning: ticket)
            } catch { waiter.continuation.resume(throwing: error) }
        }
        if let next, !waiting.isEmpty {
            wake = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(max(0.01, next.timeIntervalSinceNow))) }
                catch { return }
                await self?.pump()
            }
        }
    }

    func finish(_ ticket: Ticket, response: HTTPURLResponse? = nil, cancelled: Bool = false, now: Date = Date()) {
        var changed = false
        if let scheduled = ticket.scheduled, var state = hosts[ticket.host] {
            if let index = state.sent.firstIndex(of: scheduled) { state.sent.remove(at: index) }
            if !cancelled || scheduled <= now { state.sent.append(now); state.sent.sort() }
            let spacing = max(policy(ticket.host).spacing, policy(ticket.host).window / Double(max(1, state.ceiling ?? policy(ticket.host).limit)))
            state.nextStart = (state.sent.last ?? .distantPast).addingTimeInterval(spacing)
            hosts[ticket.host] = state
            changed = true
        }
        running[ticket.id] = nil
        backgroundRunning.remove(ticket.id)
        if let response { changed = record(host: ticket.host, response: response, now: now) || changed }
        if changed { try? save() }
        pump()
    }

    private func record(host: String, response: HTTPURLResponse, now: Date) -> Bool {
        let before = hosts[host] ?? Host()
        var state = before
        let policy = policy(host)
        if let limit = SiteResponse.seconds(response.value(forHTTPHeaderField: "X-RateLimit-Limit") ?? response.value(forHTTPHeaderField: "RateLimit-Limit")), limit >= 1 {
            let advertised = max(1, Int(min(limit * 0.95, Double(policy.limit))))
            state.advertisedCeiling = min(state.advertisedCeiling ?? advertised, advertised)
            // Old app ceilings must not permanently pin a newly measured profile.
            if state.strikes == 0 { state.ceiling = state.advertisedCeiling }
            else { state.ceiling = min(state.ceiling ?? policy.limit, advertised) }
        }
        let remaining = SiteResponse.seconds(response.value(forHTTPHeaderField: "X-RateLimit-Remaining") ?? response.value(forHTTPHeaderField: "RateLimit-Remaining"))
        if remaining == 0 { state.blocked = max(state.blocked, SiteResponse.reset(response, now: now) ?? now.addingTimeInterval(60)) }
        let status = response.statusCode
        let retry = SiteResponse.retryAfter(response, now: now)
        let forbidden = status == 403 && (response.value(forHTTPHeaderField: "cf-ray") != nil || response.value(forHTTPHeaderField: "cf-mitigated") != nil)
        if status == 429 || forbidden || (status == 503 && retry != nil) {
            state.strikes = now.timeIntervalSince(state.lastThrottle) > 3600 ? 1 : min(5, state.strikes + 1)
            state.lastThrottle = now
            let fallback = min(900, 60 * pow(2, Double(state.strikes - 1)))
            state.blocked = max(state.blocked, now.addingTimeInterval(max(retry ?? fallback, 1)))
            if status == 429 { state.ceiling = max(1, (state.ceiling ?? policy.limit) * 3 / 4) }
        } else if (500...599).contains(status) {
            state.blocked = max(state.blocked, now.addingTimeInterval(max(retry ?? 5, 1)))
        }
        let cap = min(policy.limit, state.advertisedCeiling ?? policy.limit)
        if (200..<300).contains(status), let reduced = state.ceiling, reduced < cap,
           now.timeIntervalSince(state.lastThrottle) >= 300,
           now.timeIntervalSince(state.lastRecovery ?? .distantPast) >= policy.window {
            state.ceiling = min(cap, reduced + max(1, cap / 10))
            state.lastRecovery = now
        }
        var changed = state != before
        hosts[host] = state
        if let finalHost = response.url?.host, key(finalHost) != host {
            // A redirected origin's headers apply there too, without erasing the original gate.
            var target = hosts[key(finalHost)] ?? Host()
            let previous = target.blocked
            target.blocked = max(target.blocked, state.blocked)
            changed = changed || target.blocked != previous
            hosts[key(finalHost)] = target
        }
        return changed
    }

    func ceiling(host: String) -> Int {
        let host = key(host)
        return min(policy(host).limit, hosts[host]?.ceiling ?? policy(host).limit)
    }

    var state: [String: Int] { ["running": running.count, "waiting": waiting.count, "hosts": hosts.count, "journalWrites": journalWrites] }
}
