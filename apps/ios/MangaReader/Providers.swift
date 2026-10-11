import Foundation
import KitHTML
import KitNet

// MARK: - What the sites give (the saved chapter files keep the web version's format)

struct ChapterImage: Codable, Sendable, Equatable {
    var url: String
    var width: Double?
    var height: Double?
}

struct ChapterData: Codable, Sendable, Equatable {
    var chapterId: String
    // The slug the chapter was requested with (Asura's carries its rotating suffix).
    var seriesSlug: String
    var historyId: String?
    var seriesTitle: String
    var images: [ChapterImage]
}

struct HomeChapter: Codable, Sendable, Equatable {
    var chapterId: String
    var label: String
    // An ISO date or the site's own words ("2 days ago", "October 5, 2026").
    var uploadedAt: String?
    var locked: Bool
    var unlockAt: String?
}

struct HomeSeries: Codable, Sendable, Equatable {
    var slug: String
    var historyId: String?
    var title: String
    var coverUrl: String
    var chapters: [HomeChapter]
}

struct HomePage: Sendable {
    var series: [HomeSeries]
    // The next catalog page, opaque to the app (nil: the catalog is complete).
    var nextCursor: String?
    // Later pages that may be fetched ahead, in order.
    var prefetchCursors: [String] = []
    var total: Int?
}

enum ProviderError: LocalizedError {
    case invalid(String)
    var errorDescription: String? { if case .invalid(let text) = self { return text }; return nil }
}

// One site. Identities: `key` names the site in reading progress and PC saves; a series is
// known by `identity(slug)` (Asura drops the suffix its URLs rotate); chapter IDs are the
// site's own (a number, or a slug).
protocol MangaProvider: Sendable {
    var key: String { get }
    var origin: URL { get }
    func identity(_ slug: String) -> String
    func home(_ cursor: String?) async throws -> HomePage
    // nil: the chapter is unavailable (missing, locked or paid).
    func chapter(_ slug: String, _ chapterId: String) async throws -> ChapterData?
    func chaptersNewestFirst(_ slug: String) async throws -> [String]
    // The series' first chapter (opening a series never started), without the whole list
    // where the site can say; nil when it has none.
    func oldestChapter(_ slug: String) async throws -> String?
}

extension MangaProvider {
    func identity(_ slug: String) -> String { slug }
    func oldestChapter(_ slug: String) async throws -> String? { try await chaptersNewestFirst(slug).last }
}

enum Providers {
    // By site key (Info.plist's ReaderProvider; providers.json).
    static func make(_ key: String, http client: HTTPClient) -> any MangaProvider {
        let strict = key == "qimanga" || key == "ezmanga"
        let http = SiteClient(http: client, limiter: RequestLimiter(strict ? .strict : .standard))
        return switch key {
        case "asurascans": Asura(http: http)
        case "scythescans": Scythe(http: http)
        case "yakshacomics": Yaksha(http: http)
        case "luacomic": Lua(http: http)
        case "qimanga": Angular(key: "qimanga", domain: "qimanga.com", api: "https://api.qimanga.com/api/v1", http: http)
        default: Angular(key: "ezmanga", domain: "ezmanga.org", api: "https://vapi.ezmanga.org/api/v1", http: http)
        }
    }
}

// MARK: - Shared helpers

enum Web {
    // A chapter page: nil when it is missing (404) or the site sent another page instead
    // (a redirect); other failures throw.
    static func chapterPage(_ http: SiteClient, _ url: URL) async throws -> HTTPResponse? {
        let response = try await http.send(HTTPRequest(url, accept: [404]))
        if response.status == 404 { return nil }
        let trimmed = { (url: URL) in url.path.hasSuffix("/") ? String(url.path.dropLast()) : url.path }
        if response.url.host != url.host || trimmed(response.url) != trimmed(url) { return nil }
        return response
    }

    static func json(_ http: SiteClient, _ url: URL) async throws -> Data {
        try await http.send(HTTPRequest(url)).data
    }

    // Pages of a list, in order: four at a time for the screen, one at a time in the
    // background (sites slow down for everyone under many requests at once).
    static func pages<T: Sendable>(_ numbers: ClosedRange<Int>, _ fetch: @escaping @Sendable (Int) async throws -> T) async throws -> [T] {
        let width = SiteClient.urgency?.value == true ? 4 : 1
        return try await withThrowingTaskGroup(of: (Int, T).self) { group in
            var results: [Int: T] = [:], next = numbers.lowerBound
            func start() {
                let number = next
                group.addTask { (number, try await fetch(number)) }
                next += 1
            }
            while next <= numbers.upperBound && next - numbers.lowerBound < width { start() }
            while let (number, value) = try await group.next() {
                results[number] = value
                if next <= numbers.upperBound { start() }
            }
            return numbers.compactMap { results[$0] }
        }
    }

    // URLSearchParams' encoding.
    static func query(_ pairs: [(String, String)]) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "*-._"))
        let encode = { (text: String) in text.addingPercentEncoding(withAllowedCharacters: allowed)?.replacingOccurrences(of: "%20", with: "+") ?? text }
        return pairs.map { encode($0.0) + "=" + encode($0.1) }.joined(separator: "&")
    }

    static func resolve(_ href: String, _ base: URL) -> URL? { URL(string: href.trimmingCharacters(in: .whitespacesAndNewlines), relativeTo: base)?.absoluteURL }

    // JavaScript's String(number).
    static func number(_ value: Double) -> String {
        value == value.rounded() && abs(value) < 1e15 ? String(Int(value)) : String(value)
    }

    static func collapse(_ text: String) -> String {
        text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    static func matches(_ pattern: String, in text: String, options: NSRegularExpression.Options = []) -> [[String?]] {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { return [] }
        let ns = text as NSString
        return regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { match in
            (0..<match.numberOfRanges).map { index in
                let range = match.range(at: index)
                return range.location == NSNotFound ? nil : ns.substring(with: range)
            }
        }
    }

    static func first(_ pattern: String, in text: String, options: NSRegularExpression.Options = []) -> [String?]? {
        matches(pattern, in: text, options: options).first
    }

    static func prefetch(_ page: Int, pages: Int, _ cursor: (Int) -> String) -> [String] {
        let count = max(0, min(3, pages - page))
        return count == 0 ? [] : (1...count).map { cursor(page + $0) }
    }
}

// A page's entries without those the site sent incomplete (one QiScans series without a cover
// once failed the whole catalog); a page with entries but none readable is still an error.
struct Lenient<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

extension Array {
    func readable<T>() throws -> [T] where Element == Lenient<T> {
        let values = compactMap(\.value)
        if values.isEmpty && !isEmpty { throw ProviderError.invalid("The site's page had no readable entries") }
        return values
    }
}

// Dates as the sites write them (ISO with any fraction, "October 5, 2026"); nil otherwise.
enum SiteDate {
    static func parse(_ text: String?) -> Date? {
        guard let text = text?.trimmingCharacters(in: .whitespaces), !text.isEmpty else { return nil }
        if let date = iso(text) { return date }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        for format in ["MMMM d, yyyy", "MMM d, yyyy", "yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd"] {
            formatter.dateFormat = format
            if let date = formatter.date(from: text) { return date }
        }
        return nil
    }

    private static func iso(_ text: String) -> Date? {
        // ISO8601DateFormatter reads at most milliseconds.
        var text = text
        if let match = text.range(of: #"\.(\d{3})\d+"#, options: .regularExpression) {
            text.replaceSubrange(match, with: String(text[match].prefix(4)))
        }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: text) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: text)
    }
}

// MARK: - Asura (JSON API)

struct Asura: MangaProvider {
    let key = "asurascans"
    let origin = URL(string: "https://asurascans.com")!
    static let api = "https://api.asurascans.com/api"
    let http: SiteClient

    // The site rotates a hex suffix on its URL slugs; the API slug (the identity) lacks it.
    static func historyId(_ slug: String) -> String {
        slug.replacingOccurrences(of: "-[0-9a-f]{8}$", with: "", options: [.regularExpression, .caseInsensitive])
    }

    func identity(_ slug: String) -> String { Self.historyId(slug) }

    func home(_ cursor: String?) async throws -> HomePage {
        let page = cursor.map { Int($0) ?? 0 } ?? 1
        guard page >= 1 else { throw ProviderError.invalid("Invalid Asura home cursor: \(cursor ?? "")") }
        let query = Web.query([("sort", "latest"), ("order", "desc"), ("limit", "50"), ("offset", String((page - 1) * 50))])
        return try Self.parseHome(try await Web.json(http, URL(string: "\(Self.api)/series?\(query)")!), page: page, now: Date())
    }

    private struct HomeResponse: Decodable {
        struct Series: Decodable {
            struct Chapter: Decodable { var number: Double; var is_premium: Bool; var early_access_until: String?; var published_at: String? }
            var slug: String; var title: String; var cover: String; var public_url: String; var latest_chapters: [Chapter]?
        }
        struct Meta: Decodable { var total: Int; var has_more: Bool? }
        var data: [Lenient<Series>]
        var meta: Meta
    }

    static func parseHome(_ data: Data, page: Int, now: Date) throws -> HomePage {
        let response = try JSONDecoder().decode(HomeResponse.self, from: data)
        let origin = URL(string: "https://asurascans.com")!
        let series = try response.data.readable().compactMap { series -> HomeSeries? in
            guard let path = Web.resolve(series.public_url, origin)?.path,
                  let slug = Web.first("^/comics/([^/]+)$", in: path)?[1] else { return nil }
            let chapters = (series.latest_chapters ?? []).prefix(5).map { chapter -> HomeChapter in
                let unlock = SiteDate.parse(chapter.early_access_until)
                let locked = chapter.is_premium && (chapter.early_access_until == nil || unlock.map { $0 > now } ?? true)
                return HomeChapter(chapterId: Web.number(chapter.number), label: "Chapter \(Web.number(chapter.number))",
                                   uploadedAt: chapter.published_at, locked: locked, unlockAt: locked ? chapter.early_access_until : nil)
            }
            return HomeSeries(slug: slug, historyId: historyId(series.slug), title: series.title, coverUrl: cover(series.cover), chapters: Array(chapters))
        }
        let pages = Int((Double(response.meta.total) / 50).rounded(.up))
        return HomePage(series: series, nextCursor: response.meta.has_more == true ? String(page + 1) : nil,
                        prefetchCursors: Web.prefetch(page, pages: pages) { String($0) }, total: response.meta.total)
    }

    // Covers in their 400-pixel version.
    static func cover(_ raw: String) -> String {
        guard let url = Web.resolve(raw, URL(string: "https://asurascans.com")!), var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.path.contains("/covers/"), components.path.hasSuffix(".webp") else { return raw }
        components.path = String(components.path.dropLast(5)) + "-400.webp"
        return components.url?.absoluteString ?? raw
    }

    func chapter(_ slug: String, _ chapterId: String) async throws -> ChapterData? {
        guard let response = try await Web.chapterPage(http, URL(string: "\(Self.api)/series/\(slug)/chapters/\(chapterId)")!) else { return nil }
        return try Self.parseChapter(response.data, slug: slug, chapterId: chapterId)
    }

    private struct ChapterResponse: Decodable {
        struct Body: Decodable {
            struct Chapter: Decodable { var pages: [ChapterImage] }
            struct Series: Decodable { var title: String }
            var chapter: Chapter; var series: Series; var is_locked: Bool?
        }
        var data: Body
    }

    static func parseChapter(_ data: Data, slug: String, chapterId: String) throws -> ChapterData? {
        let body = try JSONDecoder().decode(ChapterResponse.self, from: data).data
        if body.is_locked == true { return nil }
        guard !body.chapter.pages.isEmpty else { throw ProviderError.invalid("Chapter response contained no images") }
        return ChapterData(chapterId: chapterId, seriesSlug: slug, historyId: historyId(slug), seriesTitle: body.series.title, images: body.chapter.pages)
    }

    // The list is edge-cached for an hour while the catalog refreshes every 5 minutes; a
    // unique query misses that cache, so a new chapter is never missing.
    func chaptersNewestFirst(_ slug: String) async throws -> [String] {
        let millis = Int(Date().timeIntervalSince1970 * 1000)
        return try Self.parseList(try await Web.json(http, URL(string: "\(Self.api)/series/\(slug)/chapters?nocache=\(millis)")!))
    }

    static func parseList(_ data: Data) throws -> [String] {
        struct List: Decodable { struct Item: Decodable { var number: Double }; var data: [Item] }
        return try JSONDecoder().decode(List.self, from: data).data.map { Web.number($0.number) }
    }
}

// MARK: - EzScans and QiScans (one JSON API)

struct Angular: MangaProvider {
    let key: String
    let origin: URL
    let api: String
    let http: SiteClient

    init(key: String, domain: String, api: String, http: SiteClient) {
        self.key = key
        origin = URL(string: "https://\(domain)")!
        self.api = api
        self.http = http
    }

    struct SeriesItem: Decodable {
        struct Chapter: Decodable { var slug: String; var number: Double; var price: Double; var becameFreeAt: String?; var createdAt: String }
        var slug: String; var title: String; var cover: String?; var chapters: [Chapter]?
    }

    struct Listing: Decodable {
        var data: [Lenient<SeriesItem>]
        var totalItems: Int
        var totalPages: Int
        var next: Int?
    }

    // The latest updates first ("latest:N"), then the whole catalog ("catalog:N").
    func home(_ cursor: String?) async throws -> HomePage {
        var latest = true, page = 1
        if let cursor {
            guard let match = Web.first(#"^(latest|catalog):(\d+)$"#, in: cursor), let number = Int(match[2] ?? ""), number >= 1 else {
                throw ProviderError.invalid("Invalid home cursor: \(cursor)")
            }
            latest = match[1] == "latest"
            page = number
        }
        let url = latest ? "\(api)/home/latest?page=\(page)&perPage=50" : "\(api)/series?perPage=100&page=\(page)"
        return try Self.parseHome(try await Web.json(http, URL(string: url)!), latest: latest, page: page, now: Date())
    }

    static func parseHome(_ data: Data, latest: Bool, page: Int, now: Date) throws -> HomePage {
        let listing = try JSONDecoder().decode(Listing.self, from: data)
        let more = listing.next != nil || page < listing.totalPages
        let name = latest ? "latest" : "catalog"
        return HomePage(series: try listing.data.readable().map { series(from: $0, now: now) },
                        nextCursor: more ? "\(name):\(page + 1)" : latest ? "catalog:1" : nil,
                        prefetchCursors: Web.prefetch(page, pages: listing.totalPages) { "\(name):\($0)" }, total: listing.totalItems)
    }

    static func series(from item: SeriesItem, now: Date) -> HomeSeries {
        let chapters = (item.chapters ?? []).prefix(5).map { chapter -> HomeChapter in
            let free = SiteDate.parse(chapter.becameFreeAt)
            let locked = chapter.price > 0 && (free.map { $0 > now } ?? true)
            return HomeChapter(chapterId: chapter.slug, label: "Chapter \(Web.number(chapter.number))",
                               uploadedAt: locked ? chapter.createdAt : chapter.becameFreeAt ?? chapter.createdAt,
                               locked: locked, unlockAt: locked && free != nil ? chapter.becameFreeAt : nil)
        }
        return HomeSeries(slug: item.slug, title: item.title.trimmingCharacters(in: .whitespacesAndNewlines), coverUrl: item.cover ?? "", chapters: Array(chapters))
    }

    func chapter(_ slug: String, _ chapterId: String) async throws -> ChapterData? {
        guard let response = try await Web.chapterPage(http, URL(string: "\(api)/series/\(slug)/chapters/\(chapterId)")!) else { return nil }
        return try Self.parseChapter(response.data, slug: slug, chapterId: chapterId)
    }

    static func parseChapter(_ data: Data, slug: String, chapterId: String) throws -> ChapterData? {
        struct Body: Decodable {
            struct Series: Decodable { var title: String }
            var isFree: Bool; var requiresPurchase: Bool; var images: [ChapterImage]?; var series: Series
        }
        let body = try JSONDecoder().decode(Body.self, from: data)
        if !body.isFree || body.requiresPurchase { return nil }
        guard let images = body.images, !images.isEmpty else { throw ProviderError.invalid("Chapter response contained no images") }
        return ChapterData(chapterId: chapterId, seriesSlug: slug, seriesTitle: body.series.title, images: images)
    }

    // The first page says how many there are; the rest come together.
    func chaptersNewestFirst(_ slug: String) async throws -> [String] {
        let api = api, http = http
        let page = { @Sendable (number: Int) async throws -> (chapters: [String], pages: Int, more: Bool) in
            try Self.parseListPage(try await Web.json(http, URL(string: "\(api)/series/\(slug)/chapters?perPage=100&page=\(number)")!), page: number)
        }
        let first = try await page(1)
        var chapters = first.chapters, last = first
        var number = 1
        if first.pages > 1 {
            let rest = try await Web.pages(2...first.pages, page)
            chapters += rest.flatMap(\.chapters)
            last = rest.last ?? first
            number = first.pages
        }
        // A list that grew while it was read: the pages after the count, one by one.
        while last.more {
            number += 1
            last = try await page(number)
            chapters += last.chapters
        }
        return chapters
    }

    static func parseListPage(_ data: Data, page: Int) throws -> (chapters: [String], pages: Int, more: Bool) {
        struct List: Decodable { struct Item: Decodable { var slug: String }; var data: [Item]; var totalPages: Int; var next: Int? }
        let list = try JSONDecoder().decode(List.self, from: data)
        return (list.data.map(\.slug), list.totalPages, list.next != nil || page < list.totalPages)
    }

    // The API sorts by chapter number on request (one request however long the series).
    func oldestChapter(_ slug: String) async throws -> String? {
        struct List: Decodable { struct Item: Decodable { var slug: String }; var data: [Item] }
        return try JSONDecoder().decode(List.self, from: try await Web.json(http, URL(string: "\(api)/series/\(slug)/chapters?perPage=1&page=1&sort=asc")!)).data.first?.slug
    }
}

// MARK: - Lua (JSON API; chapters from the website's pages)

struct Lua: MangaProvider {
    let key = "luacomic"
    let origin = URL(string: "https://luacomic.org")!
    static let api = "https://api.luacomic.org"
    let http: SiteClient

    // The newest 100 at once, then the whole catalog in one answer ("all:N"): offset pages
    // repeat and skip series (many share a sort key) and Lua answers large queries slowly.
    func home(_ cursor: String?) async throws -> HomePage {
        var page = 1
        if let cursor {
            guard let match = Web.first(#"^all:(\d+)$"#, in: cursor), let number = Int(match[1] ?? ""), number >= 1 else {
                throw ProviderError.invalid("Invalid Lua home cursor: \(cursor)")
            }
            page = number
        }
        let query = Web.query([("page", String(page)), ("perPage", cursor == nil ? "100" : "1000"), ("series_type", "Comic"), ("query_string", ""),
                               ("orderBy", "latest"), ("adult", "true"), ("status", "All"), ("tags_ids", "[]")])
        return try Self.parseHome(try await Web.json(http, URL(string: "\(Self.api)/query?\(query)")!), cursor: cursor, page: page)
    }

    static func parseHome(_ data: Data, cursor: String?, page: Int) throws -> HomePage {
        struct Response: Decodable {
            struct Meta: Decodable { var total: Int; var last_page: Int }
            struct Series: Decodable {
                struct Chapter: Decodable { var chapter_name: String; var chapter_slug: String; var created_at: String?; var index: String? }
                var title: String; var series_slug: String; var thumbnail: String; var paid_chapters: [Chapter]?; var free_chapters: [Chapter]?
            }
            var meta: Meta; var data: [Lenient<Series>]
        }
        let response = try JSONDecoder().decode(Response.self, from: data)
        func number(_ chapter: Response.Series.Chapter) -> Double {
            let text = chapter.index ?? Web.first(#"[\d.]+"#, in: chapter.chapter_name)?[0] ?? ""
            return Double(text) ?? -.infinity
        }
        let series = try response.data.readable().map { series -> HomeSeries in
            let all = (series.paid_chapters ?? []).map { ($0, true) } + (series.free_chapters ?? []).map { ($0, false) }
            let sorted = all.enumerated().sorted { left, right in
                let a = number(left.element.0), b = number(right.element.0)
                return a != b ? a > b : left.offset < right.offset
            }.map(\.element)
            return HomeSeries(slug: series.series_slug, title: series.title, coverUrl: series.thumbnail, chapters: sorted.prefix(5).map { chapter, locked in
                HomeChapter(chapterId: chapter.chapter_slug, label: Web.collapse(chapter.chapter_name), uploadedAt: chapter.created_at, locked: locked, unlockAt: nil)
            })
        }
        let next = cursor == nil ? (response.meta.total > series.count ? "all:1" : nil) : (page < response.meta.last_page ? "all:\(page + 1)" : nil)
        return HomePage(series: series, nextCursor: next, total: response.meta.total)
    }

    func chapter(_ slug: String, _ chapterId: String) async throws -> ChapterData? {
        guard let response = try await Web.chapterPage(http, URL(string: "https://luacomic.org/series/\(slug)/\(chapterId)")!) else { return nil }
        return try Self.parseChapter(response.text, slug: slug, chapterId: chapterId)
    }

    static func parseChapter(_ html: String, slug: String, chapterId: String) throws -> ChapterData {
        // `\bsrc=` also matches data-src, which some pages use.
        let sources = Web.matches(#"<img\b[^>]*\bsrc="(https://media\.luacomic\.org/file/[^"]*/uploads/series/[^"]+\.(?:webp|jpg|png)[^"]*)"[^>]*>"#, in: html)
            .compactMap { $0[1].map { $0.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: #"\s+"#, with: "", options: .regularExpression) } }
        guard !sources.isEmpty else { throw ProviderError.invalid("Chapter response contained no images") }
        guard let title = Web.first(#"<title>(.+?)\s+-\s+Chapter\s+\d+\s+-\s+Lua Comic</title>"#, in: html, options: .caseInsensitive)?[1]?
                .trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty else {
            throw ProviderError.invalid("Chapter response did not contain the series title")
        }
        return ChapterData(chapterId: chapterId, seriesSlug: slug, seriesTitle: title, images: sources.map { ChapterImage(url: $0) })
    }

    // Lua answers a query it has answered before (for anyone) at once and any other slowly (5 to
    // 25 s): its website's pages of 30 from the newest are nearly always ready, the whole list
    // in one page of 1000 often, the pages beyond the end never. For the screen both are asked
    // and the first complete answer wins: one page of 30 is the whole of a short series, else
    // the further pages of 30 race the page of 1000. The background asks only the page of 1000
    // (one slow query rather than several).
    func chaptersNewestFirst(_ slug: String) async throws -> [String] {
        struct Series: Decodable { var id: Int }
        let id = try JSONDecoder().decode(Series.self, from: try await Web.json(http, URL(string: "\(Self.api)/series/\(slug)")!)).id
        let http = http
        let page = { @Sendable (number: Int, size: Int) async throws -> (last: Int, chapters: [String]) in
            let query = Web.query([("page", String(number)), ("perPage", String(size)), ("query", ""), ("order", "desc"), ("series_id", String(id))])
            return try Self.parseListPage(try await Web.json(http, URL(string: "\(Self.api)/chapter/query?\(query)")!))
        }
        let whole = { @Sendable () async throws -> [String] in
            let first = try await page(1, 1000)
            guard first.last > 1 else { return first.chapters }
            return first.chapters + (try await Web.pages(2...first.last) { try await page($0, 1000).chapters }).flatMap { $0 }
        }
        guard SiteClient.urgency?.value == true else { return try await whole() }
        return try await withThrowingTaskGroup(of: [String]?.self) { group in
            group.addTask { try await whole() }
            group.addTask {
                let first = try await page(1, 30)
                guard first.last > 1 else { return first.chapters }
                let rest = try await Web.pages(2...first.last) { try await page($0, 30).chapters }
                return first.chapters + rest.flatMap { $0 }
            }
            var failure: Error?
            while let result = await group.nextResult() {
                switch result {
                case .success(let chapters?):
                    group.cancelAll()
                    return chapters
                case .success(nil): break
                case .failure(let error): failure = failure ?? error
                }
            }
            throw failure ?? CancellationError()
        }
    }

    static func parseListPage(_ data: Data) throws -> (last: Int, chapters: [String]) {
        struct List: Decodable { struct Meta: Decodable { var last_page: Int }; struct Item: Decodable { var chapter_slug: String }; var meta: Meta; var data: [Item] }
        let list = try JSONDecoder().decode(List.self, from: data)
        return (list.meta.last_page, list.data.map(\.chapter_slug))
    }
}

// MARK: - Scythe (WordPress, MangaReader theme)

struct Scythe: MangaProvider {
    let key = "scythescans"
    let origin = URL(string: "https://scythescans.com")!
    let http: SiteClient

    // /<series>-chapter-<n>[.m][-k]/ (WordPress may add a collision suffix: -chapter-194-2 is 194).
    static func route(_ path: String) -> (slug: String, chapterId: String, number: String)? {
        let segments = path.split(separator: "/").map(String.init)
        guard segments.count == 1, let chapterId = segments.first,
              let match = chapterId.range(of: #"-chapter-(\d+(?:\.\d+)?)(?:-\d+)?$"#, options: .regularExpression),
              match.lowerBound != chapterId.startIndex,
              let number = Web.first(#"-chapter-(\d+(?:\.\d+)?)(?:-\d+)?$"#, in: chapterId)?[1] else { return nil }
        return (String(chapterId[..<match.lowerBound]), chapterId, number)
    }

    // Latest updates ("home:N"), then the catalog by update ("catalog:N").
    func home(_ cursor: String?) async throws -> HomePage {
        var home = true, page = 1
        if let cursor {
            guard let match = Web.first(#"^(home|catalog):(\d+)$"#, in: cursor), let number = Int(match[2] ?? ""), number >= 1 else {
                throw ProviderError.invalid("Invalid Scythe home cursor: \(cursor)")
            }
            home = match[1] == "home"
            page = number
        }
        if home {
            let url = page == 1 ? "https://scythescans.com/" : "https://scythescans.com/page/\(page)/"
            return try Self.parseHome(try await http.send(HTTPRequest(URL(string: url)!)).data, page: page)
        }
        let html = try await http.send(HTTPRequest(URL(string: "https://scythescans.com/manga/?status&type&order=update&page=\(page)")!)).data
        return try Self.parseCatalog(html, page: page)
    }

    static func parseHome(_ data: Data, page: Int) throws -> HomePage {
        let document = try HTMLDocument(data: data)
        return HomePage(series: try latestUpdate(document), nextCursor: try document.first(".pagination a.next") != nil ? "home:\(page + 1)" : "catalog:1")
    }

    static func parseCatalog(_ data: Data, page: Int) throws -> HomePage {
        let document = try HTMLDocument(data: data)
        let series = try document.select(".listupd .bs").map { card -> HomeSeries in
            var entry = try identity(of: card)
            if let number = Web.first(#"^Chapter\s+(\d+(?:\.\d+)?)"#, in: try card.first(".epxs")?.normalizedText ?? "", options: .caseInsensitive)?[1] {
                entry.chapters = [HomeChapter(chapterId: "\(entry.slug)-chapter-\(number)", label: "Chapter \(number)", uploadedAt: nil, locked: false, unlockAt: nil)]
            }
            return entry
        }
        return HomePage(series: series, nextCursor: try document.first("a.next") != nil && !series.isEmpty ? "catalog:\(page + 1)" : nil)
    }

    private static func identity(of card: HTMLNode) throws -> HomeSeries {
        let origin = URL(string: "https://scythescans.com")!
        guard let link = try card.first(".bsx > a[href*=\"/manga/\"]")?["href"], let cover = try card.first("img"),
              let title = try card.first(".tt")?.normalizedText, !title.isEmpty else { throw ProviderError.invalid("Scythe catalog card is incomplete") }
        guard let path = Web.resolve(link, origin)?.path, let slug = Web.first(#"^/manga/([^/]+)/?$"#, in: path)?[1] else {
            throw ProviderError.invalid("Invalid Scythe series URL: \(link)")
        }
        return HomeSeries(slug: slug, title: title, coverUrl: Web.resolve(cover["src"] ?? "", origin)?.absoluteString ?? "", chapters: [])
    }

    private static func latestUpdate(_ document: HTMLDocument) throws -> [HomeSeries] {
        guard let box = try document.select(".bixbox").first(where: { (try? $0.first(".releases h2")?.normalizedText) == "Latest Update" }) else {
            throw ProviderError.invalid("Scythe home did not contain Latest Update")
        }
        let origin = URL(string: "https://scythescans.com")!
        let series = try box.select(".listupd .bs").map { card -> HomeSeries in
            var entry = try identity(of: card)
            entry.chapters = try card.select("ul.chfiv > li > a").prefix(5).map { link in
                guard let href = link["href"], let path = Web.resolve(href, origin)?.path, let route = route(path), route.slug == entry.slug else {
                    throw ProviderError.invalid("Invalid Scythe home chapter URL: \(link["href"] ?? "")")
                }
                let time = try link.first(".fivtime")?.normalizedText ?? ""
                let relative = time.range(of: #"^\d+\s+(?:minute|hour|day|week|month|year|second)s?$"#, options: [.regularExpression, .caseInsensitive]) != nil
                // Coin-locked chapters are marked on their list item.
                let locked = (link.parent?["class"] ?? "").split(separator: " ").contains("center-lock")
                return HomeChapter(chapterId: route.chapterId, label: "Chapter \(route.number)", uploadedAt: time.isEmpty ? nil : relative ? time + " ago" : time,
                                   locked: locked, unlockAt: nil)
            }
            guard !entry.chapters.isEmpty else { throw ProviderError.invalid("Scythe home card \(entry.slug) has no chapters") }
            return entry
        }
        guard !series.isEmpty else { throw ProviderError.invalid("Scythe Latest Update is empty") }
        return series
    }

    // The page's base64 `ts_reader.run({...})` data.
    static func readerData(_ html: String) throws -> [String: Any] {
        for match in Web.matches(#"<script defer src="data:text/javascript;base64,([A-Za-z0-9+/=]+)"></script>"#, in: html) {
            guard let encoded = match[1], let data = Data(base64Encoded: encoded) else { continue }
            let decoded = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            guard decoded.contains("ts_reader.run(") else { continue }
            guard let json = Web.first(#"^ts_reader\.run\((\{[\s\S]*\})\);?$"#, in: decoded)?[1],
                  let object = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else { break }
            return object
        }
        throw ProviderError.invalid("Chapter response did not contain reader data")
    }

    static func images(_ data: [String: Any]) throws -> [String] {
        guard let source = data["defaultSource"] as? String, !source.trimmingCharacters(in: .whitespaces).isEmpty else {
            throw ProviderError.invalid("Reader data has no default source")
        }
        guard let sources = data["sources"] as? [[String: Any]] else { throw ProviderError.invalid("Reader sources are not an array") }
        let chosen = sources.filter { $0["source"] as? String == source }
        guard chosen.count == 1 else { throw ProviderError.invalid("Reader default source \(source) matched \(chosen.count) sources") }
        guard let images = chosen[0]["images"] as? [String], !images.isEmpty, images.allSatisfy({ !$0.trimmingCharacters(in: .whitespaces).isEmpty }) else {
            throw ProviderError.invalid("Reader default source has invalid images")
        }
        return images
    }

    func chapter(_ slug: String, _ chapterId: String) async throws -> ChapterData? {
        guard let response = try await Web.chapterPage(http, URL(string: "https://scythescans.com/\(chapterId)/")!) else { return nil }
        return try Self.parseChapter(response.text, slug: slug, chapterId: chapterId)
    }

    static func parseChapter(_ html: String, slug: String, chapterId: String) throws -> ChapterData {
        let sources = try images(try readerData(html))
        guard let title = Web.first(#"<div class="allc">All chapters are in <a[^>]*>([^<]+)</a></div>"#, in: html)?[1]?
                .trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty else {
            throw ProviderError.invalid("Chapter response did not contain the series title")
        }
        return ChapterData(chapterId: chapterId, seriesSlug: slug, seriesTitle: title, images: sources.map { ChapterImage(url: $0) })
    }

    static func parseListed(_ data: Data, slug: String) throws -> [String] {
        let origin = URL(string: "https://scythescans.com")!
        var chapters: [String] = [], seen = Set<String>()
        for link in try HTMLDocument(data: data).select("#chapterlist a[href]") {
            guard let href = link["href"], let path = Web.resolve(href, origin)?.path, let route = route(path), route.slug == slug else {
                throw ProviderError.invalid("Invalid Scythe chapter-list URL: \(link["href"] ?? "")")
            }
            if seen.insert(route.chapterId).inserted { chapters.append(route.chapterId) }
        }
        guard !chapters.isEmpty else { throw ProviderError.invalid("Scythe chapter list is empty") }
        return chapters
    }

    private func previous(_ slug: String, before chapterId: String) async throws -> String? {
        guard let response = try await Web.chapterPage(http, URL(string: "https://scythescans.com/\(chapterId)/")!) else { return nil }
        guard let previous = try Self.readerData(response.text)["prevUrl"] as? String, !previous.isEmpty,
              let path = Web.resolve(previous, origin)?.path, let route = Self.route(path), route.slug == slug else { return nil }
        return route.chapterId
    }

    // Scythe renders an uncached page slowly (6 to 85 s), so only Cloudflare-cached pages are
    // read. The cached series page can omit the newest chapters; the first Latest Update page
    // is current, so the series' chapters there go in front, joined through each chapter
    // page's previous link when the cached list is further behind (at most 10 steps or 10 s).
    // A list with a hole is never returned: the cached list is, and the next refresh retries.
    func chaptersNewestFirst(_ slug: String) async throws -> [String] {
        async let listedData = http.send(HTTPRequest(URL(string: "https://scythescans.com/manga/\(slug)/")!)).data
        async let latestData = try? http.send(HTTPRequest(URL(string: "https://scythescans.com/")!)).data
        let listed = try Self.parseListed(try await listedData, slug: slug)
        let latest = (await latestData).flatMap { try? Self.latestUpdate(HTMLDocument(data: $0)) }?
            .first { $0.slug == slug }?.chapters.map(\.chapterId) ?? []
        let known = Set(listed)
        var newer: [String] = []
        for chapter in latest {
            if known.contains(chapter) { return newer + listed }
            newer.append(chapter)
        }
        guard let start = newer.last else { return listed }
        let joined = await withTaskGroup(of: [String]?.self) { group in
            group.addTask {
                var oldest = start, steps: [String] = []
                for _ in 0..<10 {
                    guard let previous = try? await self.previous(slug, before: oldest) else { return nil }
                    if known.contains(previous) { return steps }
                    steps.append(previous)
                    oldest = previous
                }
                return nil
            }
            group.addTask { try? await Task.sleep(for: .seconds(10)); return nil }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
        return joined.map { newer + $0 + listed } ?? listed
    }
}

// MARK: - Yaksha (WordPress, Madara theme)

struct Yaksha: MangaProvider {
    let key = "yakshacomics"
    let origin = URL(string: "https://yakshacomics.com")!
    let http: SiteClient

    func home(_ cursor: String?) async throws -> HomePage {
        let page = cursor.map { Int($0) ?? 0 } ?? 1
        guard page >= 1 else { throw ProviderError.invalid("Invalid Yaksha home cursor: \(cursor ?? "")") }
        let url = page == 1 ? "https://yakshacomics.com/" : "https://yakshacomics.com/page/\(page)/"
        return try Self.parseHome(try await http.send(HTTPRequest(URL(string: url)!)).data, page: page)
    }

    static func parseHome(_ data: Data, page: Int) throws -> HomePage {
        let document = try HTMLDocument(data: data)
        let origin = URL(string: "https://yakshacomics.com")!
        let series = try document.select(".page-listing-item .page-item-detail").map { card -> HomeSeries in
            guard let link = try card.first(".post-title a"), let cover = try card.first(".item-thumb img"), let href = link["href"],
                  case let title = link.normalizedText, !title.isEmpty else { throw ProviderError.invalid("Yaksha catalog card is incomplete") }
            guard let path = Web.resolve(href, origin)?.path, let slug = Web.first(#"^/manga/([^/]+)/?$"#, in: path)?[1] else {
                throw ProviderError.invalid("Invalid Yaksha series URL: \(href)")
            }
            let chapters = try card.select(".list-chapter .chapter-item").prefix(5).map { row -> HomeChapter in
                guard let chapterLink = try row.first(".chapter a"), let chapterHref = chapterLink["href"], case let label = chapterLink.normalizedText, !label.isEmpty else {
                    throw ProviderError.invalid("Yaksha chapter in \(slug) is incomplete")
                }
                guard let chapterId = Web.resolve(chapterHref, origin)?.path.split(separator: "/").last.map(String.init) else {
                    throw ProviderError.invalid("Invalid Yaksha chapter URL: \(chapterHref)")
                }
                let date = try row.first(".post-on")?.normalizedText
                return HomeChapter(chapterId: chapterId, label: label, uploadedAt: date?.isEmpty == false ? date : nil, locked: false, unlockAt: nil)
            }
            return HomeSeries(slug: slug, title: title, coverUrl: Web.resolve(cover["src"] ?? "", origin)?.absoluteString ?? "", chapters: chapters)
        }
        let older = try document.select("a").contains { $0.normalizedText == "Older Posts" }
        return HomePage(series: series, nextCursor: older && !series.isEmpty ? String(page + 1) : nil)
    }

    func chapter(_ slug: String, _ chapterId: String) async throws -> ChapterData? {
        guard let response = try await Web.chapterPage(http, URL(string: "https://yakshacomics.com/manga/\(slug)/\(chapterId)/")!) else { return nil }
        return try Self.parseChapter(response.text, slug: slug, chapterId: chapterId)
    }

    static func parseChapter(_ html: String, slug: String, chapterId: String) throws -> ChapterData? {
        let sources = Web.matches(#"<img\b[^>]*\bclass="wp-manga-chapter-img"[^>]*>"#, in: html).compactMap { tag in
            tag[0].flatMap { Web.first(#"src="([^"]+)""#, in: $0)?[1] }.map { $0.replacingOccurrences(of: #"\s+"#, with: "", options: .regularExpression) }
        }
        if sources.isEmpty {
            // A missing chapter answers with the series page itself (200, same address).
            if let body = Web.first(#"<body[^>]*class="([^"]*)""#, in: html)?[1], body.contains("manga-page"), !body.contains("reading-manga") { return nil }
            throw ProviderError.invalid("Chapter response contained no images")
        }
        guard let title = Web.first(#"<ol class="breadcrumb">[\s\S]*?<a[^>]*href="[^"]*/manga/[^/]+/"[^>]*>([^<]+)</a>"#, in: html)?[1]?
                .trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty else {
            throw ProviderError.invalid("Chapter response did not contain the series title")
        }
        return ChapterData(chapterId: chapterId, seriesSlug: slug, seriesTitle: title, images: sources.map { ChapterImage(url: $0) })
    }

    func chaptersNewestFirst(_ slug: String) async throws -> [String] {
        Self.parseList(try await http.send(HTTPRequest(URL(string: "https://yakshacomics.com/manga/\(slug)/")!)).text)
    }

    static func parseList(_ html: String) -> [String] {
        Web.matches(#"<li class="wp-manga-chapter[^"]*">[\s\S]*?<a href="([^"]+)">[\s\S]*?Chapter\s+([\d.]+)\s*</a>"#, in: html).compactMap { $0[2].map { "chapter-" + $0 } }
    }
}
