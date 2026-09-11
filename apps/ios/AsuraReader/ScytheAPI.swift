import Foundation
import SwiftSoup

// Mirrors src/provider/scythe.ts. HTML is parsed as data, never loaded/executed in the reader.
actor ScytheAPI: ReaderSource {
    private let http = ReaderHTTP(origin: ProviderConfiguration.scythe.origin, apiBase: "https://scythescans.com")
    private func html(_ path: String) async throws -> String {
        String(decoding: try await http.request(path), as: UTF8.self)
    }
    func prioritize(_ url: String) async { await http.prioritize(url) }
    func image(_ raw: String, to destination: URL, urgent: Bool) async throws -> String {
        try await http.image(raw, to: destination, urgent: urgent)
    }
    func catalog() async throws -> [Series] {
        var result: [Series] = [], seen = Set<String>()
        var cursor: String? = "/"
        var visited = Set<String>()
        while let path = cursor {
            try Task.checkCancellation()
            guard visited.insert(path).inserted else { throw ReaderError.message("Scythe repeated a catalog page") }
            let page = try ScytheParser.catalog(await html(path), path: path)
            for series in page.series where seen.insert(series.slug).inserted { result.append(series) }
            cursor = page.next
        }
        return result
    }
    func chapters(_ slug: String) async throws -> [Chapter] {
        try ScytheParser.chapters(await html("/manga/\(slug)/"), slug: slug)
    }
    func manifest(_ slug: String, _ chapter: String, token: String?) async throws -> Manifest {
        guard let route = ScytheParser.route(chapter), route.slug == slug else { throw ReaderError.message("Invalid Scythe chapter") }
        let page = try await html("/\(chapter)/")
        let content = try ScytheParser.reader(page)
        return Manifest(slug: slug, chapter: chapter, title: content.title, seriesID: "", chapterID: chapter,
                        pages: content.images.map { PageImage(url: $0, width: 0, height: 0) }, chapters: try await chapters(slug))
    }
}

enum ScytheParser {
    struct Route { let slug: String; let id: String; let number: String }
    static func route(_ id: String) -> Route? {
        guard let match = id.range(of: "-chapter-([0-9]+(?:[.][0-9]+)?)(?:-[0-9]+)?$", options: .regularExpression), match.lowerBound != id.startIndex else { return nil }
        let suffix = String(id[match]).dropFirst("-chapter-".count)
        return Route(slug: String(id[..<match.lowerBound]), id: id, number: String(suffix.split(separator: "-")[0]))
    }
    static func linkRoute(_ link: Element, slug: String) throws -> Chapter {
        let raw = try link.attr("href")
        guard let url = URL(string: raw, relativeTo: URL(string: ProviderConfiguration.scythe.origin)),
              url.path.split(separator: "/").count == 1, let route = route(url.lastPathComponent), route.slug == slug else { throw ReaderError.message("Invalid Scythe chapter link") }
        var time = try link.select(".fivtime").text()
        if time.range(of: "^[0-9]+ (?:minute|hour|day|week|month|year)s?$", options: .regularExpression) != nil { time += " ago" }
        return Chapter(number: route.number, id: route.id, published: time)
    }
    static func catalog(_ html: String, path: String) throws -> (series: [Series], next: String?) {
        let doc = try SwiftSoup.parse(html)
        let isCatalog = path.hasPrefix("/manga/")
        let cards: Elements
        if isCatalog { cards = try doc.select(".listupd .bs") }
        else {
            guard let latest = try doc.select(".bixbox").first(where: { try $0.select(".releases h2").text() == "Latest Update" }) else { throw ReaderError.message("Scythe home did not contain Latest Update") }
            cards = try latest.select(".listupd .bs")
            guard !cards.isEmpty() else { throw ReaderError.message("Scythe Latest Update is empty") }
        }
        let series = try cards.map { card -> Series in
            guard let link = try card.select(".bsx > a[href*=/manga/]").first(), let cover = try card.select("img").first() else { throw ReaderError.message("Incomplete Scythe card") }
            let slug = URL(string: try link.attr("href"))?.lastPathComponent ?? ""
            let title = try card.select(".tt").text()
            guard CachePolicy.validSlug(slug), !title.isEmpty else { throw ReaderError.message("Invalid Scythe series") }
            var chapters: [Chapter] = []
            if isCatalog {
                let label = try card.select(".epxs").text()
                if let range = label.range(of: "[0-9]+(?:[.][0-9]+)?", options: .regularExpression) {
                    let number = String(label[range]); chapters = [Chapter(number: number, id: "\(slug)-chapter-\(number)")]
                }
            } else {
                chapters = try card.select("ul.chfiv > li > a").map { try linkRoute($0, slug: slug) }
                guard !chapters.isEmpty else { throw ReaderError.message("Scythe card has no chapters") }
                chapters = Array(chapters.prefix(5))
            }
            let coverURL = URL(string: try cover.attr("src"), relativeTo: URL(string: ProviderConfiguration.scythe.origin))?.absoluteString ?? ""
            return Series(slug: slug, identity: slug, title: title, cover: coverURL, chapters: CachePolicy.ordered(chapters))
        }
        let hasNext = try !doc.select(".pagination a.next").isEmpty()
        let page: Int
        if isCatalog {
            page = Int(URLComponents(string: "https://scythescans.com" + path)?.queryItems?.first(where: { $0.name == "page" })?.value ?? "1") ?? 1
        } else { page = Int(path.split(separator: "/").last ?? "1") ?? 1 }
        let next: String? = isCatalog ? (hasNext && !series.isEmpty ? "/manga/?status&type&order=update&page=\(page + 1)" : nil)
            : (hasNext ? "/page/\(page + 1)/" : "/manga/?status&type&order=update&page=1")
        return (series, next)
    }
    static func chapters(_ html: String, slug: String) throws -> [Chapter] {
        let doc = try SwiftSoup.parse(html)
        let result = try doc.select("#chapterlist a[href]").map { try linkRoute($0, slug: slug) }
        guard !result.isEmpty else { throw ReaderError.message("Scythe chapter list is empty") }
        return CachePolicy.ordered(result)
    }
    static func reader(_ html: String) throws -> (title: String, images: [String]) {
        let doc = try SwiftSoup.parse(html)
        var data: [String: Any]?
        for script in try doc.select("script[src]") {
            let src = try script.attr("src"), prefix = "data:text/javascript;base64,"
            guard src.hasPrefix(prefix), let bytes = Data(base64Encoded: String(src.dropFirst(prefix.count))),
                  let decoded = String(data: bytes, encoding: .utf8), decoded.contains("ts_reader.run(") else { continue }
            let text = decoded.trimmingCharacters(in: .whitespacesAndNewlines)
            guard text.hasPrefix("ts_reader.run("), text.hasSuffix(");") || text.hasSuffix(")") else { break }
            data = try object(Data(text.dropFirst("ts_reader.run(".count).dropLast(text.hasSuffix(";") ? 2 : 1).utf8)); break
        }
        guard let data, let defaultSource = data["defaultSource"] as? String, !defaultSource.trimmingCharacters(in: .whitespaces).isEmpty,
              let sources = data["sources"] as? [[String: Any]] else { throw ReaderError.message("Scythe chapter has no reader data") }
        let matches = sources.filter { $0["source"] as? String == defaultSource }
        guard matches.count == 1, let images = matches[0]["images"] as? [String], !images.isEmpty,
              images.allSatisfy({ URL(string: $0)?.scheme == "https" && URL(string: $0)?.host != nil }) else { throw ReaderError.message("Invalid Scythe default image source") }
        let title = try doc.select(".allc a").text()
        guard !title.isEmpty else { throw ReaderError.message("Scythe chapter has no series title") }
        return (title, images)
    }
}
