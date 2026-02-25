const y = [
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
], u = ["manga", "manhwa", "manhua", "other"], l = ["releasing", "finished", "on_hiatus", "discontinued", "not_yet_released"], p = {
  releasing: "Releasing",
  finished: "Finished",
  on_hiatus: "On Hiatus",
  discontinued: "Discontinued",
  not_yet_released: "Not Yet Released"
}, S = {
  manga: "Manga",
  manhwa: "Manhwa",
  manhua: "Manhua",
  other: "Other"
};
function f(n, r) {
  const e = r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), a = [
    [`\\"${e}\\"`, !0],
    [`"${e}"`, !1]
  ];
  for (const [t, o] of a) {
    const i = n.indexOf(t);
    if (i === -1) continue;
    const s = n.slice(i + t.length).match(/^\s*:\s*(\[[\s\S]*?\])/);
    if (!s) continue;
    let c = s[1];
    o && (c = c.replace(/\\"/g, '"').replace(/\\\//g, "/"));
    try {
      JSON.parse(c);
    } catch {
      continue;
    }
    return c;
  }
  throw new Error(`Key "${r}" not found in HTML (tried both escaped and unescaped patterns)`);
}
const m = "https://comix.to", d = `${m}/api/v2`, h = 30, _ = {
  id: "comix",
  name: "Comix",
  baseUrl: m,
  language: "en",
  version: "1.0.0",
  nsfw: !0,
  chapterImagesResponseType: "html",
  getFilters() {
    const n = y.map((a) => ({
      id: String(a.id),
      name: a.name,
      group: a.category
    })), r = u.map((a) => ({
      id: a,
      name: S[a] ?? a
    })), e = l.map((a) => ({
      id: a,
      name: p[a] ?? a
    }));
    return { genres: n, types: r, statuses: e };
  },
  // --- Search ---
  searchRequest(n, r, e) {
    const a = new URLSearchParams();
    if (a.set("page", String(r)), a.set("limit", String(h)), a.set("order[chapter_updated_at]", "desc"), n && a.set("keyword", n), e) {
      if (e.includeGenres)
        for (const t of e.includeGenres) a.append("genres[]", t);
      if (e.excludeGenres)
        for (const t of e.excludeGenres) a.append("genres[]", `-${t}`);
      if (((e.includeGenres?.length ?? 0) > 0 || (e.excludeGenres?.length ?? 0) > 0) && a.set("genres_mode", "and"), e.types)
        for (const t of e.types) a.append("types[]", t);
      if (e.statuses)
        for (const t of e.statuses) a.append("statuses[]", t);
    }
    return { url: `${d}/manga?${a}` };
  },
  parseSearchResponse(n) {
    const r = n, t = (r.result?.items ?? r.items ?? []).map((o) => {
      const i = o.poster, g = String(o.hash_id ?? ""), s = String(o.slug ?? "");
      return {
        id: g || s,
        title: String(o.title ?? ""),
        cover: i?.medium ?? i?.large ?? i?.small ?? "",
        latestChapter: o.latest_chapter != null ? Number(o.latest_chapter) : null,
        author: o.author ? String(o.author) : void 0,
        status: o.status ? String(o.status) : void 0
      };
    });
    return { items: t, hasMore: t.length >= h };
  },
  // --- Chapters ---
  chapterListRequest(n, r) {
    const e = new URLSearchParams();
    return e.set("limit", "100"), e.set("page", String(r)), e.set("order[number]", "desc"), { url: `${d}/manga/${n}/chapters?${e}` };
  },
  parseChapterListResponse(n) {
    return (n.result?.items ?? []).map((t) => {
      const o = t.scanlation_group;
      return {
        id: String(t.chapter_id ?? ""),
        number: parseFloat(String(t.number)),
        groupId: t.scanlation_group_id != null ? String(t.scanlation_group_id) : void 0,
        groupName: o?.name ?? "Unknown",
        uploadedAt: t.created_at != null ? Number(t.created_at) : void 0
      };
    });
  },
  // --- Chapter Images ---
  chapterImagesRequest(n, r, e) {
    return { url: `${m}/title/${n}/${r}-chapter-${e}` };
  },
  parseChapterImagesResponse(n) {
    const e = f(n, "images");
    return JSON.parse(e).map((t) => ({
      url: String(t.url ?? ""),
      width: Number(t.width ?? 0),
      height: Number(t.height ?? 0)
    }));
  },
  imageHeaders() {
    return { Referer: m };
  }
};
export {
  _ as default
};
