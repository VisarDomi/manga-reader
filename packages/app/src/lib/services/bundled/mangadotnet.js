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
function c(e) {
	let t = [], n = /streamController\.enqueue\(("(?:\\.|[^"\\])*")\)/g, r;
	for (; (r = n.exec(e)) !== null;) try {
		let e = JSON.parse(r[1]);
		typeof e == "string" && e.trim().startsWith("[") && t.push(e);
	} catch {}
	return t;
}
function l(e) {
	if (typeof e != "string") return [s(e)];
	let t = e.trim();
	return t.startsWith("<") ? c(t).map((e) => {
		try {
			return s(e);
		} catch {
			return null;
		}
	}).filter((e) => e != null) : [s(e)];
}
function u(e, t) {
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
function d(e) {
	let t = n(e);
	return t ? t.id != null && typeof t.title == "string" && (t.photo != null || t.cover != null || t.chapter_count != null) : !1;
}
function f(e) {
	let t = /* @__PURE__ */ new Set(), n = /* @__PURE__ */ new Map(), i = [e];
	for (; i.length > 0;) {
		let e = i.pop();
		if (!e || typeof e != "object" || t.has(e)) continue;
		if (t.add(e), Array.isArray(e)) {
			for (let t of e) i.push(t);
			continue;
		}
		let a = e;
		if (d(a)) {
			let e = r(a.id);
			e && !n.has(e) && n.set(e, a);
		}
		for (let e of Object.values(a)) i.push(e);
	}
	return [...n.values()];
}
function p(e) {
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
function m(e, n, r = t) {
	return {
		currentPage: e,
		lastPage: Math.max(1, Math.ceil(n / r)),
		total: n
	};
}
function h(e, r, i) {
	let o = n(e) ?? {}, s = a(o.current_page ?? o.currentPage ?? o.page) ?? r, c = a(o.per_page ?? o.perPage ?? o.page_size ?? o.limit) ?? t, l = a(o.total ?? o.total_results ?? o.totalResults ?? o.total_items ?? o.totalItems ?? o.count), u = a(o.last_page ?? o.lastPage ?? o.total_pages ?? o.totalPages);
	return l == null ? u == null ? m(s, i, c) : {
		currentPage: s,
		lastPage: Math.max(1, Math.floor(u)),
		total: Math.max(i, Math.floor(u) * c)
	} : {
		currentPage: s,
		lastPage: Math.max(1, Math.floor(u ?? Math.ceil(l / c))),
		total: l
	};
}
var g = {
	genres: [],
	types: [
		{
			id: "JP",
			name: "Manga"
		},
		{
			id: "KR",
			name: "Manhwa"
		},
		{
			id: "CN",
			name: "Manhua"
		},
		{
			id: "ONESHOT",
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
}, _ = {
	id: "mangadotnet",
	name: "Mangadotnet",
	baseUrl: e,
	language: "en",
	version: "1.0.0",
	nsfw: !0,
	chapterImagesResponseType: "json",
	getFilters() {
		return g;
	},
	setFilters(e) {
		g = e;
	},
	searchRequest(n, r, i) {
		let a = new URLSearchParams(), o = n.trim();
		a.set("search", o), o ? a.set("sortBy", "relevance") : a.set("sortBy", "latest"), a.set("page", String(r));
		for (let e of i?.includeGenres ?? []) a.append("genre", e);
		for (let e of i?.excludeGenres ?? []) a.append("genre", `-${e}`);
		for (let e of i?.types ?? []) a.append("origin", e);
		let s = i?.statuses?.[0];
		s && a.set("status", s);
		let c = i?.authors?.[0];
		c && a.set("author", c);
		let l = i?.artists?.[0];
		l && a.set("artist", l);
		let u = (i?.includeGenres?.length ?? 0) > 0 || (i?.excludeGenres?.length ?? 0) > 0 || (i?.types?.length ?? 0) > 0 || (i?.statuses?.length ?? 0) > 0 || (i?.authors?.length ?? 0) > 0 || (i?.artists?.length ?? 0) > 0;
		return a.set("limit", String(t)), u ? {
			url: `${e}/search?${a}`,
			cloudflareProtected: !0
		} : {
			url: `${e}/api/search?${a}`,
			cloudflareProtected: !0
		};
	},
	parseSearchResponse(e) {
		for (let t of l(e)) {
			let e = n(t), r = Array.isArray(e?.manga_list) ? e.manga_list.filter((e) => typeof e == "object" && !!e && !Array.isArray(e)) : null, i = r ? null : u(t, "results"), o = (r ?? (Array.isArray(i?.results) ? i.results.filter((e) => typeof e == "object" && !!e && !Array.isArray(e)) : f(t))).map(p);
			if (o.length === 0) continue;
			let s = h(e?.pagination ?? i?.pagination ?? i?.meta, a(e?.page ?? i?.page ?? i?.currentPage) ?? 1, o.length);
			return {
				items: o,
				pagination: s,
				hasMore: s.currentPage < s.lastPage
			};
		}
		return {
			items: [],
			pagination: m(1, 0),
			hasMore: !1
		};
	},
	parseMangaDetailResponse(e) {
		let t = n(e) ?? {}, r = n(t.result) ?? t, i = n(r.manga) ?? r, a = Array.isArray(r.recommendations) ? r.recommendations.filter((e) => typeof e == "object" && !!e && !Array.isArray(e)).map(p) : void 0;
		return {
			...p(i),
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
			let t = i(r(e.url)), n = Array.isArray(e.candidates) ? e.candidates.filter((e) => typeof e == "string" && e.length > 0) : t ? [t] : [];
			return {
				url: t,
				candidates: n,
				criticalCandidates: Array.isArray(e.criticalCandidates) ? e.criticalCandidates.filter((e) => typeof e == "string" && e.length > 0) : n,
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
export { _ as default };
