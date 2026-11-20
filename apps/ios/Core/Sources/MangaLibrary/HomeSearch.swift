import Foundation
import KitNet

// Home's search box. Pressing Enter sends what was typed and the catalog's titles to the PC
// (server/search.mjs), which asks a language model; the titles it answers move to the top of
// Home, best first, the rest following in their usual order. The box is offered only while the
// PC answers and its model says hi (PCSearch.available).

public struct SearchMatch: Codable, Sendable, Equatable {
    public var id: String
    public var confidence: Int
    public init(id: String, confidence: Int) { self.id = id; self.confidence = confidence }
}

// A finished search as Home shows it; kept with Home's state, so a relaunch shows it again.
public struct SearchResult: Codable, Sendable, Equatable {
    public var query: String
    public var matches: [SearchMatch]
    public init(query: String, matches: [SearchMatch]) { self.query = query; self.matches = matches }
}

// The search's state machine. Home feeds it events (the PC's availability, Enter, an emptied box,
// an answer, a failure) and performs the effects it returns, in order. Each request has its own
// number: an answer or failure for anything but the current request changes nothing.
public struct HomeSearch: Sendable, Equatable {
    public enum Phase: Sendable, Equatable {
        // Not offered: no PC, the PC not answering, or no model saying hi.
        case hidden
        // Offered; Home in its usual order.
        case ready
        // Asked; `showing` (the previous result, if any) stays on screen meanwhile.
        case searching(query: String, request: Int, showing: SearchResult?)
        // Home in this result's order.
        case showing(SearchResult)
    }

    public enum Effect: Sendable, Equatable {
        case startSearch(query: String, request: Int)
        case cancelSearch
        // Home is about to leave its usual order: keep where it is, to come back to it.
        case rememberPosition
        // Home's order: a result's, or nil for the usual one.
        case order(SearchResult?)
        // A new result: the box and the best match at the top.
        case scrollToTop
        // The usual order is back: return to the kept position.
        case returnToPosition
        // A search failed: ask again whether search is offered.
        case checkAvailability
    }

    public private(set) var phase: Phase = .hidden
    private var lastRequest = 0

    public init(restoring result: SearchResult? = nil) {
        if let result { phase = .showing(result) }
    }

    public var offered: Bool { phase != .hidden }
    public var busy: Bool { if case .searching = phase { return true }; return false }

    // The result on screen (Home's order follows it).
    public var shown: SearchResult? {
        switch phase {
        case .hidden, .ready: nil
        case .searching(_, _, let showing): showing
        case .showing(let result): result
        }
    }

    public mutating func availability(_ offered: Bool) -> [Effect] {
        switch (offered, phase) {
        case (true, .hidden): phase = .ready; return []
        case (true, _), (false, .hidden): return []
        case (false, _): return leave(to: .hidden)
        }
    }

    // Enter: a search for the trimmed text; with nothing typed, the usual order.
    public mutating func submit(_ text: String) -> [Effect] {
        if phase == .hidden { return [] }
        let query = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if query.isEmpty { return emptied() }
        lastRequest += 1
        let effects: [Effect] = busy ? [.cancelSearch] : []
        phase = .searching(query: query, request: lastRequest, showing: shown)
        return effects + [.startSearch(query: query, request: lastRequest)]
    }

    // The box was emptied: back to the usual order and position.
    public mutating func emptied() -> [Effect] {
        switch phase {
        case .hidden, .ready: []
        case .searching, .showing: leave(to: .ready)
        }
    }

    public mutating func finished(request: Int, matches: [SearchMatch]) -> [Effect] {
        guard case .searching(let query, let current, let showing) = phase, current == request else { return [] }
        let result = SearchResult(query: query, matches: matches)
        phase = .showing(result)
        return (showing == nil ? [.rememberPosition] : []) + [.order(result), .scrollToTop]
    }

    public mutating func failed(request: Int) -> [Effect] {
        guard case .searching(_, let current, let showing) = phase, current == request else { return [] }
        phase = showing.map { .showing($0) } ?? .ready
        return [.checkAvailability]
    }

    private mutating func leave(to next: Phase) -> [Effect] {
        let effects: [Effect] = busy ? [.cancelSearch] : []
        let hadResult = shown != nil
        phase = next
        return effects + (hadResult ? [.order(nil), .returnToPosition] : [])
    }
}

public enum SearchOrder {
    // The result's matches first, best first, then everything else in its usual order. Matches
    // the catalog no longer has are skipped; series new since the search keep their usual place.
    public static func apply<T>(_ items: [T], _ result: SearchResult?, id: (T) -> String) -> [T] {
        guard let result, !result.matches.isEmpty else { return items }
        var rank: [String: Int] = [:]
        for (index, match) in result.matches.enumerated() where rank[match.id] == nil { rank[match.id] = index }
        var first: [(Int, T)] = [], rest: [T] = []
        for item in items {
            if let index = rank[id(item)] { first.append((index, item)) } else { rest.append(item) }
        }
        return first.sorted { $0.0 < $1.0 }.map(\.1) + rest
    }
}

// The PC's search (server/search.mjs, /api/manga-reader/search/<site>), reached like Load/Save:
// home first, then the public route, with the same key. Both calls can take long (the PC asks a
// language model), so they go to the address that just answered Load/Save's quick status.
@MainActor
public final class PCSearch {
    static let statusWait: TimeInterval = 100
    static let searchWait: TimeInterval = 140

    private let routes: PCRoutes
    private let provider: String

    public init(routes: PCRoutes, provider: String) {
        self.routes = routes
        self.provider = provider
    }

    private var probe: String { "api/reader-backups/manual/manga-reader/\(provider)/status" }
    private var path: String { "api/manga-reader/search/\(provider)" }

    // Whether to offer search: the PC answers and its model said hi.
    public func available() async -> Bool {
        guard let response = try? await routes.slow(path + "/status", probe: probe, timeout: Self.statusWait),
              (200..<300).contains(response.status),
              let object = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any] else { return false }
        return object["ready"] as? Bool == true
    }

    public func search(_ query: String, titles: [(id: String, title: String)]) async throws -> [SearchMatch] {
        struct Entry: Encodable { let id: String; let title: String }
        struct Body: Encodable { let query: String; let titles: [Entry] }
        struct Reply: Decodable { let matches: [SearchMatch] }
        let body = try JSONEncoder().encode(Body(query: query, titles: titles.map { Entry(id: $0.id, title: $0.title) }))
        let response = try await routes.slow(path, method: "POST", body: body, probe: probe, timeout: Self.searchWait)
        guard response.status == 200 else { throw StoreError.invalid("Search failed (\(response.status))") }
        return try JSONDecoder().decode(Reply.self, from: response.data).matches
    }
}
