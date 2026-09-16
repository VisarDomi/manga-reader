import Foundation

// Opaque JSON and image files only. Provider extraction, UI and reading rules are JS.
actor ReaderStore {
    let root: URL
    let http: ReaderHTTP
    let origin: String
    let downloader: ImageDownloader
    private var windows: [String:[String]] = [:]
    private var images: [String:[String]] = [:]
    private var loaded = false
    init(root: URL, http: ReaderHTTP = ReaderHTTP(), origin: String) { self.root=root;self.http=http;self.origin=origin; self.downloader=ImageDownloader(root:root.appendingPathComponent("shared"),transfer:http,referrer:origin) }
    private func load() throws {
        guard !loaded else { return }
        if let data=try read("windows") { windows=try JSONDecoder().decode([String:[String]].self,from:data) }
        if let data=try read("images") { images=try JSONDecoder().decode([String:[String]].self,from:data) }
        loaded=true
    }
    func read(_ key: String) throws -> Data? {
        guard ["database","views","routes","windows","images"].contains(key) else { throw ReaderError.message("Invalid storage key") }
        let file=root.appendingPathComponent("shared/\(key).json")
        return FileManager.default.fileExists(atPath:file.path) ? try Data(contentsOf:file) : nil
    }
    func write(_ key: String, data: Data) throws {
        _ = try read(key)
        try writeAtomically(data,root.appendingPathComponent("shared/\(key).json"))
    }
    private func retainedURLs() -> Set<String> {
        Set(windows.values.flatMap{$0}.flatMap{images[$0] ?? []})
    }
    private func prune() throws {
        let keepKeys=Set(windows.values.flatMap{$0})
        for key in images.keys where !keepKeys.contains(key) {
            images.removeValue(forKey:key)
            let file=root.appendingPathComponent("shared/chapters/\(fileKey(key)).json")
            if FileManager.default.fileExists(atPath:file.path) { try FileManager.default.removeItem(at:file) }
        }
    }

    func command(_ command: String, data: Data) async throws -> Data {
        try load();let args=try object(data)
        switch command {
        case "read": return try read(args["key"] as? String ?? "") ?? Data("null".utf8)
        case "write": try write(args["key"] as? String ?? "",data:jsonData(args["value"] ?? NSNull()))
        case "chapter-read":
            let file=root.appendingPathComponent("shared/chapters/\(fileKey(args["key"] as? String ?? "")).json")
            return (try? Data(contentsOf:file)) ?? Data("null".utf8)
        case "chapter-write":
            guard let key=args["key"] as? String, let value=args["value"] else { throw ReaderError.message("Invalid chapter cache request") }
            try writeAtomically(jsonData(value),root.appendingPathComponent("shared/chapters/\(fileKey(key)).json"))
        case "windows-retain":
            let series=Set(args["series"] as? [String] ?? [])
            windows=windows.filter { series.contains($0.key) }
            try prune();try write("windows",data:jsonData(windows));try write("images",data:jsonData(images));try await downloader.setRetained(retainedURLs())
        case "window-current", "window":
            guard let series=args["series"] as? String else { throw ReaderError.message("Invalid download window") }
            if command == "window-current", let key=args["key"] as? String { windows[series]=Array(Set((windows[series] ?? [])+[key])) }
            else if let keys=args["keys"] as? [String] { windows[series]=keys }
            try prune();try write("windows",data:jsonData(windows));try write("images",data:jsonData(images));try await downloader.setRetained(retainedURLs())
        case "prepare":
            guard let key=args["key"] as? String,let urls=args["urls"] as? [String],windows.values.contains(where:{$0.contains(key)}) else { return Data("{}".utf8) }
            images[key]=urls;try write("images",data:jsonData(images));try await downloader.setRetained(retainedURLs())
        case "downloads-active":
            await downloader.setActive(args["active"] as? Bool == true)
        case "downloads-status": return try jsonData(await downloader.diagnostics())
        case "view-save":
            var values=try read("views").map(object) ?? [:]
            if let view=args["view"] as? [String:Any] {
                values["view"]=view;if view["home"] as? Bool == true { values["home"]=view }
                try write("views",data:jsonData(values))
            }
        default: throw ReaderError.message("Unknown native request")
        }
        return Data("{}".utf8)
    }
    func bootstrap() async throws -> Data {
        try load();try await downloader.setRetained(retainedURLs())
        var values=try read("views").map(object) ?? [:]
        values["routes"]=try read("routes").map { try JSONSerialization.jsonObject(with:$0) } ?? [:]
        return try jsonData(values)
    }
    func resource(_ url: URL) async throws -> (Data,String) {
        try load()
        guard url.host == "app" else { throw ReaderError.message("Invalid local resource") }
        if url.path == "/image" {
            let query=URLComponents(url:url,resolvingAgainstBaseURL:false)?.queryItems ?? []
            guard let source=query.first(where:{$0.name == "url"})?.value else { throw ReaderError.message("Missing image URL") }
            return try await downloader.image(source,cover:query.contains(where:{$0.name == "cover"}))
        }
        let filename=url.path == "/app.js" ? "app.js" : "index.html"
        guard let file=Bundle.main.url(forResource:filename,withExtension:nil,subdirectory:"Web") else { throw ReaderError.message("Missing reader resource") }
        return (try Data(contentsOf:file),filename.hasSuffix(".js") ? "text/javascript" : "text/html")
    }
}
