import Foundation
import KitCore
import KitNet

private final class LimitProtocol: URLProtocol, @unchecked Sendable {
    static let lock = NSLock()
    nonisolated(unsafe) static var requests: [(String, Date)] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let count = Self.lock.withLock { Self.requests.append((request.url!.path, Date())); return Self.requests.count }
        let status = request.url!.path == "/retry" && count == 1 ? 503 : 200
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Retry-After": "0"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("ok".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

enum RequestLimitChecks {
    static func response(_ status: Int, _ headers: [String: String] = [:], host: String = "violetmanga.com") -> HTTPURLResponse {
        HTTPURLResponse(url: URL(string: "https://\(host)/fixture")!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
    }
    static func run() async throws {
        let urgent = Urgency(true)
        let budget = RequestLimiter.Budget(perMinute: 4, background: 1, concurrent: 2, backgroundConcurrent: 1, window: 0.4)
        let limiter = RequestLimiter(budget)
        let first = try await limiter.acquire(host: "a", urgency: nil)
        await limiter.finish(first)
        let passed = Urgency(false)
        let waiting = Task { let t = try await limiter.acquire(host: "a", urgency: nil); passed.raise(); await limiter.finish(t) }
        let front = try await limiter.acquire(host: "a", urgency: urgent)
        expect(!passed.value, "The background quota leaves room for reader metadata/images")
        await limiter.finish(front)
        waiting.cancel()
        _ = await waiting.result

        // A single host cannot be flooded by six metadata workers plus image workers.
        let busy = try await limiter.acquire(host: "b", urgency: nil)
        let spare = try await limiter.acquire(host: "b", urgency: urgent)
        let third = Task { try await limiter.acquire(host: "b", urgency: urgent) }
        try await Task.sleep(for: .milliseconds(30))
        let gateState = await limiter.state
        expect(gateState["running"] == 2, "The common gate bounds concurrent site requests")
        third.cancel(); _ = await third.result
        await limiter.finish(busy); await limiter.finish(spare)

        // Promotion wakes an event-driven waiter without waiting for a polling interval.
        let promotedLimiter = RequestLimiter(budget)
        let used = try await promotedLimiter.acquire(host: "a", urgency: nil)
        await promotedLimiter.finish(used)
        let promotion = Urgency(false)
        let promoted = Task { try await promotedLimiter.acquire(host: "a", urgency: promotion) }
        try await Task.sleep(for: .milliseconds(30))
        promotion.raise()
        let promotedTicket = try await promoted.value
        await promotedLimiter.finish(promotedTicket)
        let ranked = RequestLimiter(.init(perMinute: 100, background: 100, concurrent: 1, backgroundConcurrent: 1, window: 0.1))
        let occupied = try await ranked.acquire(host: "rank.test", urgency: urgent)
        let lower = Urgency(true)
        let prepared = Task { try await ranked.acquire(host: "rank.test", urgency: lower) }
        try await Task.sleep(for: .milliseconds(10))
        let visible = Task { try await ranked.acquire(host: "rank.test", urgency: Urgency(true, priority: 2)) }
        try await Task.sleep(for: .milliseconds(10))
        await ranked.finish(occupied)
        let visibleTicket = try await visible.value
        let rankedState = await ranked.state
        expect(rankedState["waiting"] == 1, "The visible image passes queued chapter preparation")
        await ranked.finish(visibleTicket)
        await ranked.finish(try await prepared.value)
        print("PASS: paced request windows, shared concurrency, reader reserve, promotion and cancellation")

        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("limits.json")
        let durable = RequestLimiter(.provider("violetscans"), provider: "violetscans", file: file)
        let sent = try await durable.acquire(host: "violetmanga.com", urgency: urgent)
        await durable.finish(sent, response: response(429, ["Retry-After": "3600"]))
        let reopened = RequestLimiter(.provider("violetscans"), provider: "violetscans", file: file)
        let scheduled = try await reopened.acquire(host: "www.violetmanga.com", urgency: nil, scheduled: true)
        expect((scheduled.scheduled?.timeIntervalSinceNow ?? 0) > 3598, "Relaunch and aliases preserve the full Retry-After, including waits over two minutes")
        await reopened.finish(scheduled, cancelled: true)
        let independent = try await reopened.acquire(host: "cdn.other.test", urgency: nil)
        await reopened.finish(independent)
        let retry = try await reopened.acquire(host: "violetmanga.com", urgency: nil, scheduled: true)
        expect((retry.scheduled?.timeIntervalSinceNow ?? 0) > 3598, "Reclaiming a scheduled background request cannot erase the host cooldown")
        await reopened.finish(retry, cancelled: true)

        let api = RequestLimiter(budget, provider: "luacomic")
        let apiTicket = try await api.acquire(host: "api.luacomic.org", urgency: urgent)
        await api.finish(apiTicket, response: response(503, ["Retry-After": "600"], host: "api.luacomic.org"))
        let website = try await api.acquire(host: "luacomic.org", urgency: urgent, scheduled: true)
        expect((website.scheduled?.timeIntervalSinceNow ?? 0) > 599, "Lua API and chapter website share service cooldowns")
        await api.finish(website, cancelled: true)
        print("PASS: durable cooldowns, aliases, long Retry-After, Lua API/website sharing and independent CDN budgets")

        let server = RequestLimiter(.standard)
        let last = try await server.acquire(host: "headers.test", urgency: urgent)
        await server.finish(last, response: response(200, ["X-RateLimit-Limit": "10", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(Int(Date().timeIntervalSince1970) + 300)], host: "headers.test"))
        let stopped = try await server.acquire(host: "headers.test", urgency: nil, scheduled: true)
        expect((stopped.scheduled?.timeIntervalSinceNow ?? 0) > 298, "Successful responses with zero remaining quota stop the whole host before a 429")
        await server.finish(stopped, cancelled: true)
        let date = ImageFiles.httpDate(Date().addingTimeInterval(900))
        expect((SiteResponse.retryAfter(response(503, ["Retry-After": date])) ?? 0) > 898, "HTTP-date Retry-After is honoured")
        expect(SiteResponse.seconds("nan") == nil && SiteResponse.seconds("-1") == nil, "Malformed header numbers cannot corrupt admission")
        print("PASS: server quota headers and HTTP-date parsing")

        // Integration: retries must reacquire admission, rather than HTTPClient's
        // internal retry path running outside the common gate.
        LimitProtocol.lock.withLock { LimitProtocol.requests = [] }
        let http = HTTPClient(.init(configure: { $0.protocolClasses = [LimitProtocol.self] }))
        defer { http.invalidate() }
        let client = SiteClient(http: http, limiter: RequestLimiter(.init(perMinute: 100, background: 100, window: 0.1)))
        _ = try await client.send(HTTPRequest(URL(string: "https://transport.test/retry")!, retry: RetryPolicy(maxAttempts: 2, firstDelay: 0.01)))
        let requests = LimitProtocol.lock.withLock { LimitProtocol.requests }
        expect(requests.count == 2 && requests[1].1.timeIntervalSince(requests[0].1) >= 0.9, "Every transport retry respects the provider-wide service cooldown")
        print("PASS: transport retry admission")
    }
    private static func awaitValue(_ values: [String: Int], _ key: String) -> Int { values[key] ?? -1 }
}
