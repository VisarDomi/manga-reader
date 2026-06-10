//#region src/index.ts
var e = "https://mangataro.org";
function t(...e) {
	for (let t of e) {
		if (typeof t == "string" && t.length > 0) return t;
		if (typeof t == "number" && Number.isFinite(t)) return String(t);
	}
	return "";
}
function n(t) {
	return t ? t.startsWith("http") ? t : `${e}${t.startsWith("/") ? "" : "/"}${t}` : "";
}
function r(e) {
	let t = typeof e == "number" ? e : typeof e == "string" ? Number(e) : NaN;
	return Number.isFinite(t) ? t : null;
}
function i(e) {
	let r = t(e.id), i = e.title?.rendered, a = t(i, e.title), o = n(t(e.cover)), s = t(e.status) || void 0, c = t(e.type) || void 0, l = (Array.isArray(e.class_list) ? e.class_list : []).filter((e) => e.startsWith("tag-")).map((e) => e.replace("tag-", "")), u = c ? [c, ...l].filter(Boolean) : l.length > 0 ? l : void 0;
	return {
		id: r,
		title: a,
		cover: o,
		latestChapter: null,
		author: void 0,
		status: s,
		tags: u && u.length > 0 ? u : void 0
	};
}
var a = {
	genres: [],
	types: [
		{
			id: "Manga",
			name: "Manga"
		},
		{
			id: "Manhwa",
			name: "Manhwa"
		},
		{
			id: "Manhua",
			name: "Manhua"
		},
		{
			id: "Webtoon",
			name: "Webtoon"
		},
		{
			id: "One-shot",
			name: "One Shot"
		}
	],
	statuses: [
		{
			id: "Ongoing",
			name: "Ongoing"
		},
		{
			id: "Completed",
			name: "Completed"
		},
		{
			id: "Hiatus",
			name: "Hiatus"
		}
	]
}, o = {
	id: "mangataro",
	name: "MangaTaro",
	baseUrl: e,
	language: "en",
	version: "1.0.0",
	nsfw: !1,
	chapterImagesResponseType: "html",
	getFilters() {
		return a;
	},
	setFilters(e) {
		a = e;
	},
	searchRequest(t, n, r) {
		if (r && ((r.includeGenres?.length ?? 0) > 0 || (r.excludeGenres?.length ?? 0) > 0 || (r.types?.length ?? 0) > 0 || (r.statuses?.length ?? 0) > 0)) {
			let n = new URLSearchParams();
			if (t && n.set("s", t), r?.includeGenres) for (let e of r.includeGenres) n.append("genre", e);
			if (r?.excludeGenres) for (let e of r.excludeGenres) n.append("genre", `-${e}`);
			return r?.types?.[0] && n.set("type", r.types[0]), r?.statuses?.[0] && n.set("status", r.statuses[0]), {
				url: `${e}/browse?${n}`,
				method: "GET"
			};
		}
		let i = new URLSearchParams();
		return i.set("page", String(n)), i.set("post_type", "manga"), t && i.set("s", t), {
			url: `${e}/wp-json/manga/v1/load`,
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: i.toString()
		};
	},
	parseSearchResponse(e) {
		if (typeof e == "string" || e && typeof e == "object" && !Array.isArray(e)) {
			let t = typeof e == "string" ? e : String(e.html ?? "");
			if (t.length > 100 && t.includes("<")) {
				let e = [], n = /<a[^>]*href="https:\/\/mangataro\.org\/manga\/([^"]+)"[^>]*>[\s\S]*?<img[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[\s\S]*?<\/a>/gi, r;
				for (; (r = n.exec(t)) !== null;) {
					let t = r[1], n = r[2], i = r[3];
					t && n && e.push({
						id: t,
						title: n,
						cover: i,
						latestChapter: null,
						author: void 0,
						status: void 0,
						tags: void 0
					});
				}
				return {
					items: e,
					hasMore: e.length >= 20,
					pagination: {
						currentPage: 1,
						lastPage: e.length >= 20 ? 5 : 1,
						total: e.length * 5 || e.length
					}
				};
			}
		}
		let t = (Array.isArray(e) ? e : []).filter((e) => typeof e == "object" && !!e && !Array.isArray(e)).map(i), n = t.length, r = n >= 20;
		return {
			items: t,
			hasMore: r,
			pagination: {
				currentPage: 1,
				lastPage: r ? 5 : 1,
				total: r ? n * 5 : n
			}
		};
	},
	parseMangaDetailResponse(e) {
		let t = typeof e == "string" ? e : String(e ?? ""), r = t.match(/<meta[^>]*property="og:title"[^>]*content="([^"]*)"/)?.[1] ?? t.match(/<meta[^>]*name="title"[^>]*content="([^"]*)"/)?.[1] ?? "", i = t.match(/<meta[^>]*property="og:description"[^>]*content="([^"]*)"/)?.[1] ?? t.match(/<meta[^>]*name="description"[^>]*content="([^"]*)"/)?.[1] ?? "", a = t.match(/<meta[^>]*property="og:image"[^>]*content="([^"]*)"/)?.[1] ?? "", o = t.match(/data-manga-id="(\d+)"/)?.[1] ?? "", s = t.match(/class="text-xs[^"]*capitalize"[^>]*>([^<]*)<\/span>/)?.[1]?.trim() ?? void 0, c = t.match(/class="text-xs[^"]*capitalize"[^>]*>([^<]*)<\/span>/)?.[1]?.trim() ?? void 0;
		return {
			id: o,
			title: r,
			description: i || void 0,
			cover: n(a),
			status: s,
			tags: c ? [c] : void 0
		};
	},
	chapterListRequest(t, n) {
		return { url: `${e}/auth/manga-chapters?manga_id=${encodeURIComponent(t)}&offset=0&limit=500&order=DESC` };
	},
	parseChapterListResponse(e) {
		let n = e ?? {}, i = (Array.isArray(n.chapters) ? n.chapters : Array.isArray(n.result?.items) ? n.result.items : []).filter((e) => typeof e == "object" && !!e && !Array.isArray(e)).map((e) => {
			let n = t(e.id), i = parseFloat(String(e.chapter ?? e.number ?? "0")), a = t(e.url), o = t(e.group_name) || "Unknown", s = r(e.date_added ?? e.uploadedAt);
			return {
				id: n && n.split(":").length >= 3 ? n : (() => {
					let e = a.replace(/https?:\/\/[^\/]+\/read\//, "").replace(/\/ch\d+-.*$/, "");
					return e && i ? `${e}:${i}:${n}` : n;
				})(),
				number: i,
				groupId: t(e.group_id) || void 0,
				groupName: o,
				uploadedAt: s ?? void 0,
				url: a
			};
		});
		return {
			items: i,
			pagination: {
				currentPage: 1,
				lastPage: 1,
				total: i.length
			}
		};
	},
	chapterImagesRequest(t, n, r, i) {
		if (n.startsWith("http")) return { url: n };
		let a = n.split(":");
		if (a.length === 3) {
			let [t, n, r] = a;
			return { url: `${e}/read/${t}/ch${n}-${r}` };
		}
		return { url: `${e}/read/${n}` };
	},
	parseChapterImagesResponse(e) {
		if (e && typeof e == "object") {
			let t = e, n = t.result ?? t;
			if (Array.isArray(n.pages)) return n.pages.map((e) => {
				let t = e, n = String(t.url ?? ""), r = Array.isArray(t.candidates) ? t.candidates.filter((e) => typeof e == "string") : n ? [n] : [];
				return {
					url: n,
					candidates: r,
					criticalCandidates: Array.isArray(t.criticalCandidates) ? t.criticalCandidates.filter((e) => typeof e == "string") : r,
					width: Number(t.width ?? 0),
					height: Number(t.height ?? 0),
					scramble: t.scramble === !0
				};
			});
		}
		let t = typeof e == "string" ? e : String(e ?? ""), n = /* @__PURE__ */ new Set(), r = /https:\/\/mangataro\.yachts\/storage\/chapters\/[a-f0-9]+\/\d+\.webp/g, i;
		for (; (i = r.exec(t)) !== null;) n.add(i[0]);
		return Array.from(n).map((e) => ({
			url: e,
			candidates: [e],
			criticalCandidates: [e],
			width: 0,
			height: 0,
			scramble: !1
		}));
	},
	imageHeaders(t, n, r, i) {
		return { Referer: e };
	}
};
//#endregion
export { o as default };
