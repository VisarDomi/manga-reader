const u = [
  // Demographics (4)
  { id: 1, name: "Shoujo", category: "demographic" },
  { id: 2, name: "Shounen", category: "demographic" },
  { id: 3, name: "Josei", category: "demographic" },
  { id: 4, name: "Seinen", category: "demographic" },
  // Genres (30)
  { id: 6, name: "Action", category: "genre" },
  { id: 7, name: "Adventure", category: "genre" },
  { id: 8, name: "Boys Love", category: "genre" },
  { id: 9, name: "Comedy", category: "genre" },
  { id: 10, name: "Crime", category: "genre" },
  { id: 11, name: "Drama", category: "genre" },
  { id: 12, name: "Fantasy", category: "genre" },
  { id: 13, name: "Girls Love", category: "genre" },
  { id: 14, name: "Historical", category: "genre" },
  { id: 15, name: "Horror", category: "genre" },
  { id: 16, name: "Isekai", category: "genre" },
  { id: 17, name: "Magical Girls", category: "genre" },
  { id: 18, name: "Mecha", category: "genre" },
  { id: 19, name: "Medical", category: "genre" },
  { id: 20, name: "Mystery", category: "genre" },
  { id: 21, name: "Philosophical", category: "genre" },
  { id: 22, name: "Psychological", category: "genre" },
  { id: 23, name: "Romance", category: "genre" },
  { id: 24, name: "Sci-Fi", category: "genre" },
  { id: 25, name: "Slice of Life", category: "genre" },
  { id: 26, name: "Sports", category: "genre" },
  { id: 27, name: "Superhero", category: "genre" },
  { id: 28, name: "Thriller", category: "genre" },
  { id: 29, name: "Tragedy", category: "genre" },
  { id: 30, name: "Wuxia", category: "genre" },
  { id: 87264, name: "Adult", category: "genre" },
  { id: 87265, name: "Ecchi", category: "genre" },
  { id: 87266, name: "Hentai", category: "genre" },
  { id: 87267, name: "Mature", category: "genre" },
  { id: 87268, name: "Smut", category: "genre" },
  // Themes (37)
  { id: 31, name: "Aliens", category: "theme" },
  { id: 32, name: "Animals", category: "theme" },
  { id: 33, name: "Cooking", category: "theme" },
  { id: 34, name: "Crossdressing", category: "theme" },
  { id: 35, name: "Delinquents", category: "theme" },
  { id: 36, name: "Demons", category: "theme" },
  { id: 37, name: "Genderswap", category: "theme" },
  { id: 38, name: "Ghosts", category: "theme" },
  { id: 39, name: "Gyaru", category: "theme" },
  { id: 40, name: "Harem", category: "theme" },
  { id: 41, name: "Incest", category: "theme" },
  { id: 42, name: "Loli", category: "theme" },
  { id: 43, name: "Mafia", category: "theme" },
  { id: 44, name: "Magic", category: "theme" },
  { id: 45, name: "Martial Arts", category: "theme" },
  { id: 46, name: "Military", category: "theme" },
  { id: 47, name: "Monster Girls", category: "theme" },
  { id: 48, name: "Monsters", category: "theme" },
  { id: 49, name: "Music", category: "theme" },
  { id: 50, name: "Ninja", category: "theme" },
  { id: 51, name: "Office Workers", category: "theme" },
  { id: 52, name: "Police", category: "theme" },
  { id: 53, name: "Post-Apocalyptic", category: "theme" },
  { id: 54, name: "Reincarnation", category: "theme" },
  { id: 55, name: "Reverse Harem", category: "theme" },
  { id: 56, name: "Samurai", category: "theme" },
  { id: 57, name: "School Life", category: "theme" },
  { id: 58, name: "Shota", category: "theme" },
  { id: 59, name: "Supernatural", category: "theme" },
  { id: 60, name: "Survival", category: "theme" },
  { id: 61, name: "Time Travel", category: "theme" },
  { id: 62, name: "Traditional Games", category: "theme" },
  { id: 63, name: "Vampires", category: "theme" },
  { id: 64, name: "Video Games", category: "theme" },
  { id: 65, name: "Villainess", category: "theme" },
  { id: 66, name: "Virtual Reality", category: "theme" },
  { id: 67, name: "Zombies", category: "theme" },
  // Formats (9)
  { id: 93164, name: "4-Koma", category: "format" },
  { id: 93165, name: "Anthology", category: "format" },
  { id: 93166, name: "Award Winning", category: "format" },
  { id: 93167, name: "Adaptation", category: "format" },
  { id: 93168, name: "Doujinshi", category: "format" },
  { id: 93169, name: "Oneshot", category: "format" },
  { id: 93170, name: "Long Strip", category: "format" },
  { id: 93171, name: "Web Comic", category: "format" },
  { id: 93172, name: "Full Color", category: "format" }
], f = ["manga", "manhwa", "manhua", "other"], _ = ["releasing", "finished", "on_hiatus", "discontinued", "not_yet_released"], R = {
  releasing: "Releasing",
  finished: "Finished",
  on_hiatus: "On Hiatus",
  discontinued: "Discontinued",
  not_yet_released: "Not Yet Released"
}, M = {
  manga: "Manga",
  manhwa: "Manhwa",
  manhua: "Manhua",
  other: "Other"
}, w = [87264, 87265, 87266, 87267, 87268];
function A(o, r) {
  const a = r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), t = [
    [`\\"${a}\\"`, !0],
    [`"${a}"`, !1]
  ];
  for (const [e, m] of t) {
    const c = o.indexOf(e);
    if (c === -1) continue;
    const n = o.slice(c + e.length).match(/^\s*:\s*(\[[\s\S]*?\])/);
    if (!n) continue;
    let s = n[1];
    m && (s = s.replace(/\\"/g, '"').replace(/\\\//g, "/"));
    try {
      JSON.parse(s);
    } catch {
      continue;
    }
    return s;
  }
  throw new Error(`Key "${r}" not found in HTML (tried both escaped and unescaped patterns)`);
}
const g = "https://comix.to", l = `${g}/api/v2`, y = 100, L = {
  id: "comix",
  name: "Comix",
  baseUrl: g,
  language: "en",
  version: "1.0.0",
  nsfw: !0,
  chapterImagesResponseType: "html",
  getFilters() {
    const o = new Set(w.map(Number)), r = u.map((e) => ({
      id: String(e.id),
      name: e.name,
      group: e.category,
      ...o.has(e.id) ? { nsfw: !0 } : {}
    })), a = f.map((e) => ({
      id: e,
      name: M[e] ?? e
    })), t = _.map((e) => ({
      id: e,
      name: R[e] ?? e
    }));
    return { genres: r, types: a, statuses: t };
  },
  // --- Search ---
  searchRequest(o, r, a) {
    const t = new URLSearchParams();
    if (t.set("page", String(r)), t.set("limit", String(y)), o ? t.set("keyword", o) : t.set("order[chapter_updated_at]", "desc"), a) {
      if (a.includeGenres)
        for (const e of a.includeGenres) t.append("genres[]", e);
      if (a.excludeGenres)
        for (const e of a.excludeGenres) t.append("genres[]", `-${e}`);
      if (((a.includeGenres?.length ?? 0) > 0 || (a.excludeGenres?.length ?? 0) > 0) && t.set("genres_mode", "and"), a.types)
        for (const e of a.types) t.append("types[]", e);
      if (a.statuses)
        for (const e of a.statuses) t.append("statuses[]", e);
    }
    return { url: `${l}/manga?${t}`, cloudflareProtected: !0 };
  },
  parseSearchResponse(o) {
    const r = o, a = r.result, t = a?.items ?? r.items ?? [], e = a?.pagination ?? r.pagination, m = /* @__PURE__ */ new Map();
    for (const n of u) m.set(n.id, n.name);
    const c = t.map((n) => {
      const s = n.poster, p = String(n.hash_id ?? ""), S = String(n.slug ?? ""), h = n.term_ids?.map((d) => m.get(d)).filter((d) => d != null);
      return {
        id: p || S,
        title: String(n.title ?? ""),
        cover: s?.medium ?? s?.large ?? s?.small ?? "",
        latestChapter: n.latest_chapter != null ? Number(n.latest_chapter) : null,
        author: n.author ? String(n.author) : void 0,
        status: n.status ? String(n.status) : void 0,
        tags: h?.length ? h : void 0
      };
    }), i = e ? {
      currentPage: Number(e.current_page ?? 1),
      lastPage: Number(e.last_page ?? 1),
      total: Number(e.total ?? t.length)
    } : void 0;
    return { items: c, hasMore: c.length >= y, pagination: i };
  },
  // --- Chapters ---
  chapterListRequest(o, r) {
    const a = new URLSearchParams();
    return a.set("limit", "100"), a.set("page", String(r)), a.set("order[number]", "desc"), { url: `${l}/manga/${o}/chapters?${a}`, cloudflareProtected: !0 };
  },
  parseChapterListResponse(o) {
    const r = o, a = r.result, t = a?.items ?? [], e = a?.pagination ?? r.pagination, m = t.map((i) => {
      const n = i.scanlation_group;
      return {
        id: String(i.chapter_id ?? ""),
        number: parseFloat(String(i.number)),
        groupId: i.scanlation_group_id != null ? String(i.scanlation_group_id) : void 0,
        groupName: n?.name ?? "Unknown",
        uploadedAt: i.created_at != null ? Number(i.created_at) : void 0
      };
    }), c = {
      currentPage: Number(e?.current_page ?? 1),
      lastPage: Number(e?.last_page ?? 1),
      total: Number(e?.total ?? t.length)
    };
    return { items: m, pagination: c };
  },
  // --- Chapter Images ---
  chapterImagesRequest(o, r, a) {
    return { url: `${g}/title/${o}/${r}-chapter-${a}`, cloudflareProtected: !0 };
  },
  parseChapterImagesResponse(o) {
    const a = A(o, "images");
    return JSON.parse(a).map((e) => ({
      url: String(e.url ?? ""),
      width: Number(e.width ?? 0),
      height: Number(e.height ?? 0)
    }));
  },
  imageHeaders() {
    return { Referer: g };
  }
};
export {
  L as default
};
