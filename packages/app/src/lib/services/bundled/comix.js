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
];
//#endregion
//#region src/parse.ts
function o(e, t) {
	let n = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), r = [[`\\"${n}\\"`, !0], [`"${n}"`, !1]];
	for (let [t, n] of r) {
		let r = e.indexOf(t);
		if (r === -1) continue;
		let i = e.slice(r + t.length).match(/^\s*:\s*(\[[\s\S]*?\])/);
		if (!i) continue;
		let a = i[1];
		n && (a = a.replace(/\\"/g, "\"").replace(/\\\//g, "/"));
		try {
			JSON.parse(a);
		} catch {
			continue;
		}
		return a;
	}
	throw Error(`Key "${t}" not found in HTML (tried both escaped and unescaped patterns)`);
}
//#endregion
//#region src/index.ts
var s = "https://comix.to", c = `${s}/api/v2`, l = 100, u = {
	id: "comix",
	name: "Comix",
	baseUrl: s,
	language: "en",
	version: "1.0.0",
	nsfw: !0,
	chapterImagesResponseType: "html",
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
		if (r.set("page", String(t)), r.set("limit", String(l)), e ? r.set("keyword", e) : r.set("order[chapter_updated_at]", "desc"), n) {
			if (n.includeGenres) for (let e of n.includeGenres) r.append("genres[]", e);
			if (n.excludeGenres) for (let e of n.excludeGenres) r.append("genres[]", `-${e}`);
			if (((n.includeGenres?.length ?? 0) > 0 || (n.excludeGenres?.length ?? 0) > 0) && r.set("genres_mode", "and"), n.types) for (let e of n.types) r.append("types[]", e);
			if (n.statuses) for (let e of n.statuses) r.append("statuses[]", e);
		}
		return {
			url: `${c}/manga?${r}`,
			cloudflareProtected: !0
		};
	},
	parseSearchResponse(t) {
		let n = t, r = n.result, i = r?.items ?? n.items ?? [], a = r?.pagination ?? n.pagination, o = /* @__PURE__ */ new Map();
		for (let t of e) o.set(t.id, t.name);
		let s = i.map((e) => {
			let t = e.poster, n = String(e.hash_id ?? ""), r = String(e.slug ?? ""), i = e.term_ids?.map((e) => o.get(e)).filter((e) => e != null);
			return {
				id: n || r,
				title: String(e.title ?? ""),
				cover: t?.medium ?? t?.large ?? t?.small ?? "",
				latestChapter: e.latest_chapter == null ? null : Number(e.latest_chapter),
				author: e.author ? String(e.author) : void 0,
				status: e.status ? String(e.status) : void 0,
				tags: i?.length ? i : void 0
			};
		}), c = a ? {
			currentPage: Number(a.current_page ?? 1),
			lastPage: Number(a.last_page ?? 1),
			total: Number(a.total ?? i.length)
		} : void 0;
		return {
			items: s,
			hasMore: s.length >= l,
			pagination: c
		};
	},
	chapterListRequest(e, t) {
		let n = new URLSearchParams();
		return n.set("limit", "100"), n.set("page", String(t)), n.set("order[number]", "desc"), {
			url: `${c}/manga/${e}/chapters?${n}`,
			cloudflareProtected: !0
		};
	},
	parseChapterListResponse(e) {
		let t = e, n = t.result, r = n?.items ?? [], i = n?.pagination ?? t.pagination;
		return {
			items: r.map((e) => {
				let t = e.scanlation_group;
				return {
					id: String(e.chapter_id ?? ""),
					number: parseFloat(String(e.number)),
					groupId: e.scanlation_group_id == null ? void 0 : String(e.scanlation_group_id),
					groupName: t?.name ?? "Unknown",
					uploadedAt: e.created_at == null ? void 0 : Number(e.created_at)
				};
			}),
			pagination: {
				currentPage: Number(i?.current_page ?? 1),
				lastPage: Number(i?.last_page ?? 1),
				total: Number(i?.total ?? r.length)
			}
		};
	},
	chapterImagesRequest(e, t, n) {
		return {
			url: `${s}/title/${e}/${t}-chapter-${n}`,
			cloudflareProtected: !0
		};
	},
	parseChapterImagesResponse(e) {
		let t = o(e, "images");
		return JSON.parse(t).map((e) => ({
			url: String(e.url ?? ""),
			width: Number(e.width ?? 0),
			height: Number(e.height ?? 0)
		}));
	},
	imageHeaders(e, t, n) {
		return { Referer: `${s}/title/${e}/${t}-chapter-${n}` };
	}
};
//#endregion
export { u as default };
