import Foundation
import KitNet

// Whether the work running now is waited for on screen. Set by MetadataQueue for the work it
// runs and raised while it runs (someone opened what the background was fetching).
final class Urgency: @unchecked Sendable {
    private let lock = NSLock()
    private var raised: Bool
    init(_ urgent: Bool) { raised = urgent }
    var value: Bool { lock.withLock { raised } }
    func raise() { lock.withLock { raised = true } }
}

// A site's requests, within its budget. Sites limit requests per address: QiScans and EzScans
// answer 60 a minute, then "429 Too Many Requests" with a wait of up to a minute for every
// request, including the chapter being opened. The catalog and the lists of every started
// series could ask more than that at launch, so background work spends only part of each
// minute and what the screen waits for has the rest. A 429 holds the site's requests until
// its wait is over.
struct SiteClient: Sendable {
    @TaskLocal static var urgency: Urgency?

    let http: HTTPClient
    let limiter: RequestLimiter

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        let policy = request.retry ?? (["GET", "HEAD"].contains(request.method) ? .reads : .never)
        var once = request
        once.retry = .never
        let host = request.url.host ?? ""
        let urgency = Self.urgency
        return try await policy.run {
            try await limiter.acquire(host: host, urgency: urgency)
            do { return try await http.send(once) }
            catch let error as HTTPStatusError where error.status == 429 {
                await limiter.throttled(host: host, retryAfter: error.retryAfter)
                throw error
            }
        }
    }
}

actor RequestLimiter {
    struct Budget: Sendable {
        // Requests in any minute, and how many of those background work may use.
        var perMinute: Int
        var background: Int

        // QiScans and EzScans (60 a minute) leave a margin; the others publish no limit.
        static let strict = Budget(perMinute: 50, background: 30)
        static let standard = Budget(perMinute: 120, background: 60)
    }

    private let budget: Budget
    private let clock = ContinuousClock()
    private var sent: [String: [ContinuousClock.Instant]] = [:]
    private var blocked: [String: ContinuousClock.Instant] = [:]

    init(_ budget: Budget) { self.budget = budget }

    func acquire(host: String, urgency: Urgency?) async throws {
        while true {
            try Task.checkCancellation()
            let now = clock.now
            var times = (sent[host] ?? []).filter { now - $0 < .seconds(60) }
            let wait: Duration
            if let until = blocked[host], until > now {
                wait = until - now
            } else {
                let allowed = urgency?.value == true ? budget.perMinute : budget.background
                if times.count < allowed {
                    times.append(now)
                    sent[host] = times
                    return
                }
                // When enough of this minute's requests have aged out.
                wait = times[times.count - allowed] + .seconds(60) - now
            }
            sent[host] = times
            // Short naps, so work raised to urgent while waiting goes as soon as it may.
            try await Task.sleep(for: min(max(wait, .milliseconds(50)), .milliseconds(500)))
        }
    }

    func throttled(host: String, retryAfter: Double?) {
        let until = clock.now + .seconds(min(max(retryAfter ?? 30, 1), 120))
        if blocked[host].map({ $0 < until }) ?? true { blocked[host] = until }
    }

}
