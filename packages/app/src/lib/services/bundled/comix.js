//#region src/terms.ts
var e = [
	{
		id: 1,
		name: "Shoujo",
		category: "demographic"
	},
	{
		id: 2,
		name: "Shounen",
		category: "demographic"
	},
	{
		id: 3,
		name: "Josei",
		category: "demographic"
	},
	{
		id: 4,
		name: "Seinen",
		category: "demographic"
	},
	{
		id: 6,
		name: "Action",
		category: "genre"
	},
	{
		id: 7,
		name: "Adventure",
		category: "genre"
	},
	{
		id: 8,
		name: "Boys Love",
		category: "genre"
	},
	{
		id: 9,
		name: "Comedy",
		category: "genre"
	},
	{
		id: 10,
		name: "Crime",
		category: "genre"
	},
	{
		id: 11,
		name: "Drama",
		category: "genre"
	},
	{
		id: 12,
		name: "Fantasy",
		category: "genre"
	},
	{
		id: 13,
		name: "Girls Love",
		category: "genre"
	},
	{
		id: 14,
		name: "Historical",
		category: "genre"
	},
	{
		id: 15,
		name: "Horror",
		category: "genre"
	},
	{
		id: 16,
		name: "Isekai",
		category: "genre"
	},
	{
		id: 17,
		name: "Magical Girls",
		category: "genre"
	},
	{
		id: 18,
		name: "Mecha",
		category: "genre"
	},
	{
		id: 19,
		name: "Medical",
		category: "genre"
	},
	{
		id: 20,
		name: "Mystery",
		category: "genre"
	},
	{
		id: 21,
		name: "Philosophical",
		category: "genre"
	},
	{
		id: 22,
		name: "Psychological",
		category: "genre"
	},
	{
		id: 23,
		name: "Romance",
		category: "genre"
	},
	{
		id: 24,
		name: "Sci-Fi",
		category: "genre"
	},
	{
		id: 25,
		name: "Slice of Life",
		category: "genre"
	},
	{
		id: 26,
		name: "Sports",
		category: "genre"
	},
	{
		id: 27,
		name: "Superhero",
		category: "genre"
	},
	{
		id: 28,
		name: "Thriller",
		category: "genre"
	},
	{
		id: 29,
		name: "Tragedy",
		category: "genre"
	},
	{
		id: 30,
		name: "Wuxia",
		category: "genre"
	},
	{
		id: 87264,
		name: "Adult",
		category: "genre"
	},
	{
		id: 87265,
		name: "Ecchi",
		category: "genre"
	},
	{
		id: 87266,
		name: "Hentai",
		category: "genre"
	},
	{
		id: 87267,
		name: "Mature",
		category: "genre"
	},
	{
		id: 87268,
		name: "Smut",
		category: "genre"
	},
	{
		id: 31,
		name: "Aliens",
		category: "theme"
	},
	{
		id: 32,
		name: "Animals",
		category: "theme"
	},
	{
		id: 33,
		name: "Cooking",
		category: "theme"
	},
	{
		id: 34,
		name: "Crossdressing",
		category: "theme"
	},
	{
		id: 35,
		name: "Delinquents",
		category: "theme"
	},
	{
		id: 36,
		name: "Demons",
		category: "theme"
	},
	{
		id: 37,
		name: "Genderswap",
		category: "theme"
	},
	{
		id: 38,
		name: "Ghosts",
		category: "theme"
	},
	{
		id: 39,
		name: "Gyaru",
		category: "theme"
	},
	{
		id: 40,
		name: "Harem",
		category: "theme"
	},
	{
		id: 41,
		name: "Incest",
		category: "theme"
	},
	{
		id: 42,
		name: "Loli",
		category: "theme"
	},
	{
		id: 43,
		name: "Mafia",
		category: "theme"
	},
	{
		id: 44,
		name: "Magic",
		category: "theme"
	},
	{
		id: 45,
		name: "Martial Arts",
		category: "theme"
	},
	{
		id: 46,
		name: "Military",
		category: "theme"
	},
	{
		id: 47,
		name: "Monster Girls",
		category: "theme"
	},
	{
		id: 48,
		name: "Monsters",
		category: "theme"
	},
	{
		id: 49,
		name: "Music",
		category: "theme"
	},
	{
		id: 50,
		name: "Ninja",
		category: "theme"
	},
	{
		id: 51,
		name: "Office Workers",
		category: "theme"
	},
	{
		id: 52,
		name: "Police",
		category: "theme"
	},
	{
		id: 53,
		name: "Post-Apocalyptic",
		category: "theme"
	},
	{
		id: 54,
		name: "Reincarnation",
		category: "theme"
	},
	{
		id: 55,
		name: "Reverse Harem",
		category: "theme"
	},
	{
		id: 56,
		name: "Samurai",
		category: "theme"
	},
	{
		id: 57,
		name: "School Life",
		category: "theme"
	},
	{
		id: 58,
		name: "Shota",
		category: "theme"
	},
	{
		id: 59,
		name: "Supernatural",
		category: "theme"
	},
	{
		id: 60,
		name: "Survival",
		category: "theme"
	},
	{
		id: 61,
		name: "Time Travel",
		category: "theme"
	},
	{
		id: 62,
		name: "Traditional Games",
		category: "theme"
	},
	{
		id: 63,
		name: "Vampires",
		category: "theme"
	},
	{
		id: 64,
		name: "Video Games",
		category: "theme"
	},
	{
		id: 65,
		name: "Villainess",
		category: "theme"
	},
	{
		id: 66,
		name: "Virtual Reality",
		category: "theme"
	},
	{
		id: 67,
		name: "Zombies",
		category: "theme"
	},
	{
		id: 93164,
		name: "4-Koma",
		category: "format"
	},
	{
		id: 93165,
		name: "Anthology",
		category: "format"
	},
	{
		id: 93166,
		name: "Award Winning",
		category: "format"
	},
	{
		id: 93167,
		name: "Adaptation",
		category: "format"
	},
	{
		id: 93168,
		name: "Doujinshi",
		category: "format"
	},
	{
		id: 93169,
		name: "Oneshot",
		category: "format"
	},
	{
		id: 93170,
		name: "Long Strip",
		category: "format"
	},
	{
		id: 93171,
		name: "Web Comic",
		category: "format"
	},
	{
		id: 93172,
		name: "Full Color",
		category: "format"
	}
], t = [
	"manga",
	"manhwa",
	"manhua",
	"other"
], n = [
	"releasing",
	"finished",
	"on_hiatus",
	"discontinued",
	"not_yet_released"
], r = {
	releasing: "Releasing",
	finished: "Finished",
	on_hiatus: "On Hiatus",
	discontinued: "Discontinued",
	not_yet_released: "Not Yet Released"
}, i = {
	manga: "Manga",
	manhwa: "Manhwa",
	manhua: "Manhua",
	other: "Other"
}, a = [
	87264,
	87265,
	87266,
	87267,
	87268
], o = "https://comix.to", s = `${o}/api/v1`, c = 100;
function l(...e) {
	for (let t of e) {
		if (typeof t == "string" && t.length > 0) return t;
		if (typeof t == "number" && Number.isFinite(t)) return String(t);
	}
	return "";
}
function u(e, t) {
	return {
		currentPage: Number(e?.current_page ?? e?.page ?? 1),
		lastPage: Number(e?.last_page ?? e?.lastPage ?? 1),
		total: Number(e?.total ?? t)
	};
}
function d(e) {
	return e ? e.startsWith("http") ? e : `${o}${e.startsWith("/") ? "" : "/"}${e}` : "";
}
function f(e) {
	return Array.isArray(e) ? e.map((e) => typeof e == "string" ? e : e && typeof e == "object" ? l(e.title, e.name) : "").filter(Boolean) : [];
}
function p(e, t) {
	return f(e[t]);
}
function m(t) {
	let n = t.poster, r = l(t.hash_id, t.hid), i = l(t.slug), a = t.term_ids, o = /* @__PURE__ */ new Map();
	for (let t of e) o.set(t.id, t.name);
	let s = a?.map((e) => o.get(e)).filter((e) => e != null);
	return {
		id: r || i,
		title: String(t.title ?? ""),
		cover: n?.medium ?? n?.large ?? n?.small ?? "",
		latestChapter: t.latest_chapter != null || t.latestChapter != null ? Number(t.latest_chapter ?? t.latestChapter) : null,
		author: t.author ? String(t.author) : void 0,
		status: t.status ? String(t.status) : void 0,
		tags: s?.length ? s : void 0
	};
}
var h = {
	id: "comix",
	name: "Comix",
	baseUrl: o,
	language: "en",
	version: "1.0.0",
	nsfw: !0,
	chapterImagesResponseType: "json",
	getFilters() {
		let o = new Set(a.map(Number));
		return {
			genres: e.map((e) => ({
				id: String(e.id),
				name: e.name,
				group: e.category,
				...o.has(e.id) ? { nsfw: !0 } : {}
			})),
			types: t.map((e) => ({
				id: e,
				name: i[e] ?? e
			})),
			statuses: n.map((e) => ({
				id: e,
				name: r[e] ?? e
			}))
		};
	},
	searchRequest(e, t, n) {
		let r = new URLSearchParams();
		if (r.set("page", String(t)), r.set("limit", String(c)), e ? r.set("keyword", e) : r.set("order[chapter_updated_at]", "desc"), n) {
			if (n.includeGenres) for (let e of n.includeGenres) r.append("genres_in[]", e);
			if (n.excludeGenres) for (let e of n.excludeGenres) r.append("genres_ex[]", e);
			if (((n.includeGenres?.length ?? 0) > 0 || (n.excludeGenres?.length ?? 0) > 0) && r.set("genres_mode", "and"), n.types) for (let e of n.types) r.append("types[]", e);
			if (n.statuses) for (let e of n.statuses) r.append("statuses[]", e);
		}
		return {
			url: `${s}/manga?${r}`,
			cloudflareProtected: !0
		};
	},
	parseSearchResponse(e) {
		let t = e, n = t.result, r = n?.items ?? t.items ?? [], i = n?.pagination ?? n?.meta ?? t.pagination ?? t.meta, a = r.map((e) => m(e)), o = i ? u(i, r.length) : void 0;
		return {
			items: a,
			hasMore: o ? o.currentPage < o.lastPage : a.length >= c,
			pagination: o
		};
	},
	parseMangaDetailResponse(e) {
		let t = e, n = t.result ?? t, r = n.poster, i = p(n, "genres"), a = p(n, "tags"), o = p(n, "demographics"), s = p(n, "authors"), c = p(n, "artists"), u = f(n.altTitles ?? n.alt_titles), d = [...s, ...c.filter((e) => !s.includes(e))], h = (Array.isArray(n.recommendations) ? n.recommendations : []).map((e) => m(e));
		return {
			id: l(n.hid, n.hash_id, n.id),
			title: String(n.title ?? ""),
			cover: r?.large ?? r?.medium ?? r?.small ?? "",
			latestChapter: n.latestChapter != null || n.latest_chapter != null ? Number(n.latestChapter ?? n.latest_chapter) : null,
			status: n.status ? String(n.status) : void 0,
			author: d.length > 0 ? d.join(", ") : void 0,
			altTitles: u.length > 0 ? u : void 0,
			description: l(n.synopsis, n.description),
			genres: i.length > 0 ? i : void 0,
			tags: a.length > 0 ? a : void 0,
			demographics: o.length > 0 ? o : void 0,
			authors: d.length > 0 ? d : void 0,
			recommendations: h.length > 0 ? h : void 0
		};
	},
	chapterListRequest(e, t) {
		let n = new URLSearchParams();
		return n.set("limit", "100"), n.set("page", String(t)), n.set("order[number]", "desc"), {
			url: `${s}/manga/${e}/chapters?${n}`,
			cloudflareProtected: !0
		};
	},
	parseChapterListResponse(e) {
		let t = e, n = t.result, r = n?.items ?? [], i = n?.pagination ?? n?.meta ?? t.pagination ?? t.meta;
		return {
			items: r.map((e) => {
				let t = e.scanlation_group ?? e.group;
				return {
					id: l(e.chapter_id, e.id),
					number: parseFloat(String(e.number)),
					groupId: l(e.scanlation_group_id, t?.id) || void 0,
					groupName: t?.name ?? "Unknown",
					uploadedAt: e.created_at == null ? void 0 : Number(e.created_at),
					url: d(l(e.url))
				};
			}),
			pagination: u(i, r.length)
		};
	},
	chapterImagesRequest(e, t, n, r) {
		return {
			url: `${s}/chapters/${t}`,
			cloudflareProtected: !0,
			signingMangaId: e,
			signingPageUrl: d(r ?? "") || void 0
		};
	},
	parseChapterImagesResponse(e) {
		return (e.result?.pages ?? []).map((e) => ({
			url: String(e.url ?? ""),
			width: Number(e.width ?? 0),
			height: Number(e.height ?? 0)
		}));
	},
	imageHeaders(e, t, n, r) {
		return { Referer: d(r ?? "") || `${o}/title/${e}/${t}-chapter-${n}` };
	}
};
//#endregion
export { h as default };
