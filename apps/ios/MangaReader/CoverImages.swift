import UIKit
import KitCore
import KitImages

// Persistent bytes belong to ImageFiles. This only prepares a bounded set of
// display-sized images: visible work first, then the catalog's order, one ahead.
@MainActor
final class CoverImages {
    static let fit = ImageFit.cover(width: 450, height: 600)
    private struct Warm { let key: String; let image: UIImage; let cost: Int }
    private let files: ImageFiles
    private let pipeline: ImagePipeline
    private let version: (String) -> Int
    private let budget = 64 << 20
    private var urls: [String] = []
    private var positions: [String: Int] = [:]
    private var ready = Set<String>()
    private var visible = Set<String>()
    private var warm: [String: Warm] = [:]
    private var bytes = 0
    private var cursor = 0
    private var active = false
    private var warming = OperationState()
    private enum Capacity { case available, saturated, memoryPressure }
    private var capacity = Capacity.available
    private var saturated: Bool { capacity != .available }
    private var memoryLimited: Bool { capacity == .memoryPressure }
    private var ticket: ImageTicket?
    private var generation = 0
    private var memoryObservation: NotificationObservation?
    private var coverObservation: NotificationObservation?
    private(set) var decoded = 0
    #if targetEnvironment(simulator)
    private(set) var preparedOrder: [String] = []
    #endif

    init(files: ImageFiles, pipeline: ImagePipeline, version: @escaping (String) -> Int) {
        self.files = files; self.pipeline = pipeline; self.version = version
        memoryObservation = NotificationObservation(name: UIApplication.didReceiveMemoryWarningNotification) { [weak self] _ in
            MainActor.assumeIsolated { self?.warm.removeAll(); self?.bytes = 0; self?.cancelWarm(); self?.capacity = .memoryPressure }
        }
        coverObservation = NotificationObservation(name: .coverChanged) { [weak self] note in
            guard let url = note.userInfo?["url"] as? String else { return }
            MainActor.assumeIsolated { self?.changed(url) }
        }
        Task { [weak self, files] in
            await files.onFinished { [weak self] item in
                guard item.cover else { return }
                Task { @MainActor [weak self] in self?.available(item.url) }
            }
        }
    }

    func setCatalog(_ values: [String]) {
        var seen = Set<String>()
        let ordered = values.filter { !$0.isEmpty && seen.insert($0).inserted }
        guard ordered != urls else { return }
        urls = ordered; positions = Dictionary(uniqueKeysWithValues: urls.enumerated().map { ($0.element, $0.offset) })
        ready.formIntersection(seen)
        cancelWarm()
        for url in Array(warm.keys) where !seen.contains(url) { discard(url) }
        generation += 1
        let revision = generation, items = urls.map { ImageItem(url: $0, cover: true) }
        cursor = visible.compactMap { positions[$0] }.min() ?? 0
        Task { [weak self, files] in
            let complete = Set(await files.completed(items.map(\.name)))
            guard let self, generation == revision else { return }
            ready.formUnion(items.filter { complete.contains($0.name) }.map(\.url))
            pump()
        }
    }

    func setActive(_ value: Bool) {
        active = value
        if !value { cancelWarm() }
        if value && memoryLimited { capacity = .available }
        pump()
    }

    func setVisible(_ values: [String]) {
        let next = Set(values)
        guard visible != next else { return }
        visible = next
        let first = values.compactMap { positions[$0] }.min() ?? 0
        for url in Array(warm.keys) where (positions[url] ?? -1) < first && !next.contains(url) { discard(url) }
        cursor = first; if !memoryLimited { capacity = .available }
        pipeline.prioritiesChanged()
        pump()
    }

    func key(_ url: String) -> String {
        let value = version(url)
        return "cover:" + url + (value > 0 ? "#\(value)" : "")
    }

    func cached(_ url: String) -> UIImage? {
        let key = key(url)
        if let stored = warm[url], stored.key == key { return stored.image }
        return pipeline.cached(key, fit: Self.fit)
    }

    func loadVisible(_ url: String, completion: @escaping (Result<UIImage, Error>) -> Void) -> ImageTicket {
        visible.insert(url)
        let item = ImageItem(url: url, cover: true), files = files, key = key(url)
        let request = ImagePipeline.Request(key: key, source: .load { try await files.file(item) }, fit: Self.fit,
                                            localFile: files.localFile(item)) { [weak self] in
            self?.visible.contains(url) == true ? 0 : Double((self?.positions[url] ?? 0) + 1)
        }
        return pipeline.load(request) { [weak self] result in
            if case .success(let image) = result { self?.remember(url, key: key, image: image) }
            completion(result)
        }
    }

    private func available(_ url: String) {
        ready.insert(url)
        let first = visible.compactMap { positions[$0] }.min() ?? 0
        if let index = positions[url], index >= first { cursor = min(cursor, index) }
        pump()
    }

    private func changed(_ url: String) {
        discard(url); if !memoryLimited { capacity = .available }
        if let index = positions[url] { cursor = min(cursor, index) }
        pump()
    }

    private func discard(_ url: String) { if let entry = warm.removeValue(forKey: url) { bytes -= entry.cost } }

    private func remember(_ url: String, key: String, image: UIImage) {
        if let entry = warm[url], entry.key == key && entry.image === image { return }
        #if targetEnvironment(simulator)
        preparedOrder.append(url)
        #endif
        discard(url)
        let cost = Int(image.size.width * image.size.height * image.scale * image.scale * 4)
        warm[url] = Warm(key: key, image: image, cost: cost); bytes += cost
        while bytes > budget, let farthest = warm.keys.filter({ !visible.contains($0) }).max(by: { (positions[$0] ?? -1) < (positions[$1] ?? -1) }) {
            discard(farthest)
        }
        if !memoryLimited { capacity = bytes + cost > budget ? .saturated : .available }
    }

    private func cancelWarm() {
        warming.cancel(); ticket?.cancel(); ticket = nil
    }

    private func pump() {
        guard active, !warming.isRunning, !memoryLimited else { return }
        while cursor < urls.count {
            let index = cursor, url = urls[index]
            if let stored = warm[url], stored.key == key(url) { cursor += 1; continue }
            if !ready.contains(url) { cursor += 1; continue }
            if saturated {
                guard let farthest = warm.keys.filter({ !visible.contains($0) && (positions[$0] ?? -1) > index }).max(by: { positions[$0]! < positions[$1]! }) else { return }
                discard(farthest); capacity = .available
            }
            cursor += 1
            if let image = cached(url) { remember(url, key: key(url), image: image); continue }
            let item = ImageItem(url: url, cover: true)
            let operation = warming.begin()
            let key = key(url)
            let request = ImagePipeline.Request(key: key, source: .file(files.url(item)), fit: Self.fit) { [weak self] in
                self?.visible.contains(url) == true ? 0 : Double(index + 1)
            }
            let loading = pipeline.load(request) { [weak self] result in
                guard let self, warming.finish(operation) else { return }
                ticket = nil
                if case .success(let image) = result { decoded += 1; remember(url, key: key, image: image) }
                pump()
            }
            // A cached/restored image may complete synchronously and start the
            // next decode. Do not overwrite that new owner's cancellation ticket.
            if warming.phase == .running(operation) { ticket = loading }
            return
        }
    }

    var state: [String: Int] { ["decoded": decoded, "warm": warm.count, "bytes": bytes, "budget": budget, "cursor": cursor] }
}
