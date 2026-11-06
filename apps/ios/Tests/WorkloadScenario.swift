import Foundation
import CoreGraphics
import ImageIO
import KitCore

struct MangaWorkReport: Codable, Sendable {
    let pages: Int
    let completionReplans: Int
    let movementReplans: Int
    let priorityUpdates: Int
    let preparationCPUSeconds: Double
    let completionCPUSeconds: Double
    let movementCPUSeconds: Double
    let fileChecks: Int
    let metadataReads: Int
}

// One CPU/work-count scenario shared by native model tests and the simulator-only app.
@MainActor
enum MangaWorkload {
    static func run(root: URL, seriesCount: Int = 100, phase: (String) -> Void = { _ in }) async throws -> MangaWorkReport {
        phase("Preparing offline metadata")
        let entries = (0..<seriesCount).map { HomeSeries(slug: "series-\($0)", title: "Fixture", coverUrl: "", chapters: []) }
        try DurableFile.writeJSON(Catalog(series: entries, complete: true), to: root.appendingPathComponent("catalog.json"))
        let chapterFiles = ChapterFiles(directory: root)
        let readingState = ReadingState(directory: root, provider: "fixture")
        for entry in entries {
            readingState.save(series: entry.slug, chapterId: "1", imageIndex: 0, totalImages: 25)
            for chapter in ["1", "2"] {
                let pages = (0..<25).map { ChapterImage(url: "https://fixture.invalid/\(entry.slug)/\(chapter)/\($0).jpg", width: 1, height: 1, dimensionsMeasured: true) }
                await chapterFiles.save(ChapterData(chapterId: chapter, seriesSlug: entry.slug, seriesTitle: entry.title, images: pages), series: entry.slug)
            }
            await chapterFiles.saveList(["2", "1"], series: entry.slug)
        }
        readingState.flush()
        let library = Library(provider: OfflineWorkProvider(), root: root, bundleID: "com.visar.MangaWork." + UUID().uuidString)
        await library.images.setActive(false)
        let preparationCPU = clock()
        library.planSoon()
        for _ in 0..<1000 {
            if await library.images.state["planned"] == seriesCount * 50 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        guard await library.images.state["planned"] == seriesCount * 50 else { throw URLError(.timedOut) }
        try await Task.sleep(for: .milliseconds(100))
        let preparationSeconds = Double(clock() - preparationCPU) / Double(CLOCKS_PER_SEC)
        let initial = library.debugState["fullPlans"] as? Int ?? 0
        let jpeg = NSMutableData()
        let pixels = CGDataProvider(data: Data(repeating: 255, count: 4) as CFData)!
        let image = CGImage(width: 1, height: 1, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: 4,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
                            provider: pixels, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
        let destination = CGImageDestinationCreateWithData(jpeg, "public.jpeg" as CFString, 1, nil)!
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw URLError(.cannotDecodeContentData) }
        let bytes = jpeg as Data
        phase("50 image completions")
        let completionCPU = clock()
        for chapter in ["1", "2"] {
            for page in 0..<25 {
                let item = ImageItem(url: "https://fixture.invalid/series-0/\(chapter)/\(page).jpg", cover: false)
                let file = library.images.url(item)
                try await Task.detached(priority: .utility) {
                    try DurableFile.write(bytes, to: file)
                    try DurableFile.write(Data("image/jpeg".utf8), to: file.appendingPathExtension("mime"))
                    _ = ImageDimensions.measure(file)
                }.value
                await library.images.committed(item.name)
                await Task.yield()
            }
        }
        try await Task.sleep(for: .milliseconds(200))
        let completionReplans = (library.debugState["fullPlans"] as? Int ?? 0) - initial
        let completionSeconds = Double(clock() - completionCPU) / Double(CLOCKS_PER_SEC)
        let readerOwner = NSObject()
        library.state.save(series: "series-1", chapterId: "1", imageIndex: 0, totalImages: 25)
        library.reading(readerOwner, Library.Reading(series: "series-1", slug: "series-1", chapters: ["1", "2"], chapter: "1", page: 0), visible: true)
        try await Task.sleep(for: .milliseconds(300))
        let beforePages = library.debugState["fullPlans"] as? Int ?? 0
        phase("80 page movements and progress saves")
        let movementCPU = clock()
        for page in 1...80 {
            library.reading(readerOwner, Library.Reading(series: "series-1", slug: "series-1", chapters: ["1", "2"], chapter: "1", page: page % 20), visible: true)
            library.state.save(series: "series-1", chapterId: "1", imageIndex: page % 20, totalImages: 25)
            await Task.yield()
        }
        try await Task.sleep(for: .milliseconds(200))
        let movementSeconds = Double(clock() - movementCPU) / Double(CLOCKS_PER_SEC)
        let state = await library.images.state
        return MangaWorkReport(pages: seriesCount * 50, completionReplans: completionReplans,
                               movementReplans: (library.debugState["fullPlans"] as? Int ?? 0) - beforePages,
                               priorityUpdates: library.debugState["priorityPlans"] as? Int ?? 0,
                               preparationCPUSeconds: preparationSeconds,
                               completionCPUSeconds: completionSeconds, movementCPUSeconds: movementSeconds,
                               fileChecks: state["fileChecks"] ?? -1, metadataReads: await library.chapters.files.diskReads)
    }
}

private struct OfflineWorkProvider: MangaProvider {
    let key = "fixture"
    let origin = URL(string: "https://fixture.invalid")!
    func home(_ cursor: String?) async throws -> HomePage { throw URLError(.notConnectedToInternet) }
    func chapter(_ slug: String, _ chapterId: String) async throws -> ChapterData? { throw URLError(.notConnectedToInternet) }
    func chaptersNewestFirst(_ slug: String) async throws -> [String] { throw URLError(.notConnectedToInternet) }
}
