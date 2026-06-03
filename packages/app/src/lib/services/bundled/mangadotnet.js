//#region src/index.ts
var e = "https://mangadot.net", t = 100;
function n(e) {
	return typeof e == "object" && e && !Array.isArray(e) ? e : void 0;
}
function r(...e) {
	for (let t of e) {
		if (typeof t == "string" && t.length > 0) return t;
		if (typeof t == "number" && Number.isFinite(t)) return String(t);
	}
	return "";
}
function i(t) {
	return t ? t.startsWith("http") ? t : `${e}${t.startsWith("/") ? "" : "/"}${t}` : "";
}
function a(e) {
	let t = typeof e == "number" ? e : typeof e == "string" ? Number(e) : NaN;
	return Number.isFinite(t) ? t : null;
}
function o(e) {
	if (Array.isArray(e)) return e.filter((e) => typeof e == "string" && e.length > 0);
	if (typeof e != "string" || e.length === 0) return [];
	try {
		let t = JSON.parse(e);
		return Array.isArray(t) ? t.filter((e) => typeof e == "string" && e.length > 0) : [];
	} catch {
		return [];
	}
}
function s(e) {
	if (typeof e != "string") return e;
	let t = JSON.parse(e), n = /* @__PURE__ */ new Map(), r = (e) => {
		if (n.has(e)) return n.get(e);
		let i = t[e];
		if (Array.isArray(i)) {
			let t = [];
			n.set(e, t);
			for (let e of i) t.push(typeof e == "number" ? r(e) : e);
			return t;
		}
		if (i && typeof i == "object") {
			let t = {};
			n.set(e, t);
			for (let [e, n] of Object.entries(i)) {
				let i = /^_(\d+)$/.exec(e)?.[1], a = i ? String(r(Number(i))) : e;
				t[a] = typeof n == "number" ? r(n) : n;
			}
			return t;
		}
		return i;
	};
	return r(0);
}
function c(e, t) {
	let n = /* @__PURE__ */ new Set(), r = [e];
	for (; r.length > 0;) {
		let e = r.pop();
		if (!(!e || typeof e != "object" || n.has(e))) if (n.add(e), Array.isArray(e)) for (let t of e) r.push(t);
		else {
			let n = e;
			if (Array.isArray(n[t])) return n;
			for (let e of Object.values(n)) r.push(e);
		}
	}
	return null;
}
function l(e) {
	let t = n(e);
	return t ? t.id != null && typeof t.title == "string" && (t.photo != null || t.cover != null || t.chapter_count != null) : !1;
}
function u(e) {
	let t = /* @__PURE__ */ new Set(), n = /* @__PURE__ */ new Map(), i = [e];
	for (; i.length > 0;) {
		let e = i.pop();
		if (!e || typeof e != "object" || t.has(e)) continue;
		if (t.add(e), Array.isArray(e)) {
			for (let t of e) i.push(t);
			continue;
		}
		let a = e;
		if (l(a)) {
			let e = r(a.id);
			e && !n.has(e) && n.set(e, a);
		}
		for (let e of Object.values(a)) i.push(e);
	}
	return [...n.values()];
}
function d(e) {
	let t = r(e.id), n = a(e.chapter_count ?? e.latestChapter ?? e.latest_chapter), s = o(e.authors), c = o(e.artists), l = [...s, ...c.filter((e) => !s.includes(e))], u = Array.isArray(e.genres) ? e.genres.filter((e) => typeof e == "string") : [];
	return {
		id: t,
		title: r(e.title),
		cover: i(r(e.photo, e.cover)),
		latestChapter: n,
		author: l.length > 0 ? l.join(", ") : void 0,
		status: r(e.status) || void 0,
		tags: u.length > 0 ? u : void 0,
		genres: u.length > 0 ? u : void 0,
		altTitles: Array.isArray(e.alt_titles) ? e.alt_titles.filter((e) => typeof e == "string") : void 0,
		description: r(e.description) || void 0,
		authors: l.length > 0 ? l : void 0
	};
}
function f(e, n, r = t) {
	return {
		currentPage: e,
		lastPage: Math.max(1, Math.ceil(n / r)),
		total: n
	};
}
function p(e, r, i) {
	let o = n(e) ?? {}, s = a(o.current_page ?? o.currentPage ?? o.page) ?? r, c = a(o.per_page ?? o.perPage ?? o.page_size ?? o.limit) ?? t, l = a(o.total ?? o.total_results ?? o.totalResults ?? o.total_items ?? o.totalItems ?? o.count), u = a(o.last_page ?? o.lastPage ?? o.total_pages ?? o.totalPages);
	return l == null ? u == null ? f(s, i, c) : {
		currentPage: s,
		lastPage: Math.max(1, Math.floor(u)),
		total: Math.max(i, Math.floor(u) * c)
	} : {
		currentPage: s,
		lastPage: Math.max(1, Math.floor(u ?? Math.ceil(l / c))),
		total: l
	};
}
var m = {
	genres: [],
	types: [
		{
			id: "all",
			name: "All"
		},
		{
			id: "manga",
			name: "Manga"
		},
		{
			id: "manhwa",
			name: "Manhwa"
		},
		{
			id: "manhua",
			name: "Manhua"
		},
		{
			id: "one-shot",
			name: "One Shot"
		}
	],
	statuses: [
		{
			id: "any",
			name: "Any"
		},
		{
			id: "ongoing",
			name: "Ongoing"
		},
		{
			id: "completed",
			name: "Completed"
		},
		{
			id: "hiatus",
			name: "Hiatus"
		}
	]
}, h = {
	id: "mangadotnet",
	name: "Mangadotnet",
	baseUrl: e,
	language: "en",
	version: "1.0.0",
	nsfw: !0,
	chapterImagesResponseType: "json",
	getFilters() {
		return m;
	},
	searchRequest(n, r, i) {
		let a = new URLSearchParams(), o = n.trim();
		return a.set("search", o), o ? a.set("sortBy", "relevance") : a.set("sortBy", "latest"), a.set("page", String(r)), a.set("limit", String(t)), {
			url: `${e}/api/search?${a}`,
			cloudflareProtected: !0
		};
	},
	parseSearchResponse(e) {
		let t = s(e), r = n(t), i = Array.isArray(r?.manga_list) ? r.manga_list.filter((e) => typeof e == "object" && !!e && !Array.isArray(e)) : null, o = i ? null : c(t, "results"), l = (i ?? (Array.isArray(o?.results) ? o.results.filter((e) => typeof e == "object" && !!e && !Array.isArray(e)) : u(t))).map(d), f = p(r?.pagination ?? o?.pagination ?? o?.meta, a(r?.page ?? o?.page ?? o?.currentPage) ?? 1, l.length);
		return {
			items: l,
			pagination: f,
			hasMore: f.currentPage < f.lastPage
		};
	},
	parseMangaDetailResponse(e) {
		let t = n(e) ?? {}, r = n(t.result) ?? t, i = n(r.manga) ?? r, a = Array.isArray(r.recommendations) ? r.recommendations.filter((e) => typeof e == "object" && !!e && !Array.isArray(e)).map(d) : void 0;
		return {
			...d(i),
			recommendations: a
		};
	},
	chapterListRequest(t, n) {
		return {
			url: `${e}/api/manga/${encodeURIComponent(t)}/chapters/list`,
			cloudflareProtected: !0
		};
	},
	parseChapterListResponse(t) {
		let i = n((n(t) ?? {}).result), o = (Array.isArray(i?.items) ? i.items : Array.isArray(t) ? t : []).filter((e) => typeof e == "object" && !!e && !Array.isArray(e)).map((t) => {
			let n = r(t.group_name, t.scanlator_name) || "Unknown", i = typeof t.date_added == "string" ? Math.floor(new Date(t.date_added).getTime() / 1e3) : void 0;
			return {
				id: r(t.id),
				number: a(t.chapter_number) ?? 0,
				groupId: r(t.group_id) || void 0,
				groupName: n,
				uploadedAt: i,
				url: `${e}/chapter/${encodeURIComponent(r(t.id))}?source=${encodeURIComponent(r(t.source) || "user")}`
			};
		});
		return {
			items: o,
			pagination: {
				currentPage: 1,
				lastPage: 1,
				total: o.length
			}
		};
	},
	chapterImagesRequest(t, n) {
		return {
			url: `${e}/api/uploads/${encodeURIComponent(n)}/images`,
			cloudflareProtected: !0
		};
	},
	parseChapterImagesResponse(e) {
		let t = n(e) ?? {}, o = n(t.result) ?? t;
		return (Array.isArray(o.pages) ? o.pages : Array.isArray(o.images) ? o.images : []).filter((e) => typeof e == "object" && !!e && !Array.isArray(e)).map((e) => {
			let t = i(r(e.url));
			return {
				url: t,
				candidates: t ? [t] : [],
				criticalCandidates: t ? [t] : [],
				width: a(e.w ?? e.width) ?? 0,
				height: a(e.h ?? e.height) ?? 0,
				scramble: !1
			};
		});
	},
	imageHeaders() {
		return { Referer: e };
	}
};
//#endregion
export { h as default };
