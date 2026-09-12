import Foundation
import SwiftSoup

// Mirrors src/provider/yaksha.ts. No remote page scripts execute in the app.
actor YakshaAPI: ReaderSource {
    private let http = ReaderHTTP(origin: ProviderConfiguration.yaksha.origin, apiBase: "https://yakshacomics.com")
    func prioritize(_ url: String) async { await http.prioritize(url) }
    func image(_ raw: String, to destination: URL, urgent: Bool) async throws -> String { try await http.image(raw, to: destination, urgent: urgent) }
    private func html(_ path: String) async throws -> String { String(decoding: try await http.request(path), as: UTF8.self) }
    static func url(_ raw: String) throws -> URL {
        guard let url = URL(string: raw, relativeTo: URL(string: ProviderConfiguration.yaksha.origin))?.absoluteURL, url.scheme == "https" else { throw ReaderError.message("Invalid Yaksha URL") }
        return url
    }
    static func catalog(_ html: String) throws -> (series: [Series], more: Bool) {
        let doc = try SwiftSoup.parse(html)
        let series = try doc.select(".page-listing-item .page-item-detail").map { card -> Series in
            guard let link = try card.select(".post-title a").first(), let cover = try card.select(".item-thumb img").first() else { throw ReaderError.message("Incomplete Yaksha card") }
            let slug = try url(link.attr("href")).lastPathComponent
            guard CachePolicy.validSlug(slug) else { throw ReaderError.message("Invalid Yaksha series") }
            let chapters = try card.select(".list-chapter .chapter-item").prefix(5).map { row -> Chapter in
                guard let link = try row.select(".chapter a").first() else { throw ReaderError.message("Incomplete Yaksha chapter") }
                let id = try url(link.attr("href")).lastPathComponent
                return Chapter(number: NativeProviderData.chapterNumber(id), id: id, published: try row.select(".post-on").text())
            }
            return Series(slug: slug, identity: slug, title: try link.text(), cover: try url(cover.attr("src")).absoluteString, chapters: CachePolicy.ordered(chapters))
        }
        let more = try doc.select("a").contains { try $0.text() == "Older Posts" }
        return (series, more && !series.isEmpty)
    }
    func catalog() async throws -> [Series] {
        var result: [Series] = [], seen = Set<String>(), page = 1
        while true {
            try Task.checkCancellation()
            let data = try Self.catalog(await html(page == 1 ? "/" : "/page/\(page)/"))
            for series in data.series where seen.insert(series.slug).inserted { result.append(series) }
            if !data.more { break }
            guard page < 10000 else { throw ReaderError.message("Invalid Yaksha pagination") }; page += 1
        }
        return result
    }
    static func chapters(_ html: String) throws -> [Chapter] {
        let doc = try SwiftSoup.parse(html)
        return CachePolicy.ordered(try doc.select("li.wp-manga-chapter a[href]").map { link in
            let id = try url(link.attr("href")).lastPathComponent
            return Chapter(number: NativeProviderData.chapterNumber(id), id: id)
        })
    }
    func chapters(_ slug: String) async throws -> [Chapter] { try Self.chapters(await html("/manga/\(slug)/")) }
    static func reader(_ html: String) throws -> (title: String, pages: [PageImage]) {
        let doc = try SwiftSoup.parse(html)
        let pages = try doc.select("img.wp-manga-chapter-img[src]").map { image in
            try NativeProviderData.image(image.attr("src").components(separatedBy: .whitespacesAndNewlines).joined())
        }
        guard let link = try doc.select("ol.breadcrumb a[href*=/manga/]").first(), !pages.isEmpty else { throw ReaderError.message("Yaksha chapter contains no reader data") }
        return (try link.text(), pages)
    }
    func manifest(_ slug: String, _ chapter: String, token: String?) async throws -> Manifest {
        let data = try Self.reader(await html("/manga/\(slug)/\(chapter)/"))
        return Manifest(slug: slug, chapter: chapter, title: data.title, seriesID: "", chapterID: chapter, pages: data.pages, chapters: try await chapters(slug))
    }
}
