export interface Term {
    id: number;
    name: string;
    category: 'demographic' | 'genre' | 'theme' | 'format';
}

export const TERMS: Term[] = [
    // Demographics (4)
    { id: 1, name: 'Shoujo', category: 'demographic' },
    { id: 2, name: 'Shounen', category: 'demographic' },
    { id: 3, name: 'Josei', category: 'demographic' },
    { id: 4, name: 'Seinen', category: 'demographic' },

    // Genres (30)
    { id: 6, name: 'Action', category: 'genre' },
    { id: 7, name: 'Adventure', category: 'genre' },
    { id: 8, name: 'Boys Love', category: 'genre' },
    { id: 9, name: 'Comedy', category: 'genre' },
    { id: 10, name: 'Crime', category: 'genre' },
    { id: 11, name: 'Drama', category: 'genre' },
    { id: 12, name: 'Fantasy', category: 'genre' },
    { id: 13, name: 'Girls Love', category: 'genre' },
    { id: 14, name: 'Historical', category: 'genre' },
    { id: 15, name: 'Horror', category: 'genre' },
    { id: 16, name: 'Isekai', category: 'genre' },
    { id: 17, name: 'Magical Girls', category: 'genre' },
    { id: 18, name: 'Mecha', category: 'genre' },
    { id: 19, name: 'Medical', category: 'genre' },
    { id: 20, name: 'Mystery', category: 'genre' },
    { id: 21, name: 'Philosophical', category: 'genre' },
    { id: 22, name: 'Psychological', category: 'genre' },
    { id: 23, name: 'Romance', category: 'genre' },
    { id: 24, name: 'Sci-Fi', category: 'genre' },
    { id: 25, name: 'Slice of Life', category: 'genre' },
    { id: 26, name: 'Sports', category: 'genre' },
    { id: 27, name: 'Superhero', category: 'genre' },
    { id: 28, name: 'Thriller', category: 'genre' },
    { id: 29, name: 'Tragedy', category: 'genre' },
    { id: 30, name: 'Wuxia', category: 'genre' },
    { id: 87264, name: 'Adult', category: 'genre' },
    { id: 87265, name: 'Ecchi', category: 'genre' },
    { id: 87266, name: 'Hentai', category: 'genre' },
    { id: 87267, name: 'Mature', category: 'genre' },
    { id: 87268, name: 'Smut', category: 'genre' },

    // Themes (37)
    { id: 31, name: 'Aliens', category: 'theme' },
    { id: 32, name: 'Animals', category: 'theme' },
    { id: 33, name: 'Cooking', category: 'theme' },
    { id: 34, name: 'Crossdressing', category: 'theme' },
    { id: 35, name: 'Delinquents', category: 'theme' },
    { id: 36, name: 'Demons', category: 'theme' },
    { id: 37, name: 'Genderswap', category: 'theme' },
    { id: 38, name: 'Ghosts', category: 'theme' },
    { id: 39, name: 'Gyaru', category: 'theme' },
    { id: 40, name: 'Harem', category: 'theme' },
    { id: 41, name: 'Incest', category: 'theme' },
    { id: 42, name: 'Loli', category: 'theme' },
    { id: 43, name: 'Mafia', category: 'theme' },
    { id: 44, name: 'Magic', category: 'theme' },
    { id: 45, name: 'Martial Arts', category: 'theme' },
    { id: 46, name: 'Military', category: 'theme' },
    { id: 47, name: 'Monster Girls', category: 'theme' },
    { id: 48, name: 'Monsters', category: 'theme' },
    { id: 49, name: 'Music', category: 'theme' },
    { id: 50, name: 'Ninja', category: 'theme' },
    { id: 51, name: 'Office Workers', category: 'theme' },
    { id: 52, name: 'Police', category: 'theme' },
    { id: 53, name: 'Post-Apocalyptic', category: 'theme' },
    { id: 54, name: 'Reincarnation', category: 'theme' },
    { id: 55, name: 'Reverse Harem', category: 'theme' },
    { id: 56, name: 'Samurai', category: 'theme' },
    { id: 57, name: 'School Life', category: 'theme' },
    { id: 58, name: 'Shota', category: 'theme' },
    { id: 59, name: 'Supernatural', category: 'theme' },
    { id: 60, name: 'Survival', category: 'theme' },
    { id: 61, name: 'Time Travel', category: 'theme' },
    { id: 62, name: 'Traditional Games', category: 'theme' },
    { id: 63, name: 'Vampires', category: 'theme' },
    { id: 64, name: 'Video Games', category: 'theme' },
    { id: 65, name: 'Villainess', category: 'theme' },
    { id: 66, name: 'Virtual Reality', category: 'theme' },
    { id: 67, name: 'Zombies', category: 'theme' },

    // Formats (9)
    { id: 93164, name: '4-Koma', category: 'format' },
    { id: 93165, name: 'Anthology', category: 'format' },
    { id: 93166, name: 'Award Winning', category: 'format' },
    { id: 93167, name: 'Adaptation', category: 'format' },
    { id: 93168, name: 'Doujinshi', category: 'format' },
    { id: 93169, name: 'Oneshot', category: 'format' },
    { id: 93170, name: 'Long Strip', category: 'format' },
    { id: 93171, name: 'Web Comic', category: 'format' },
    { id: 93172, name: 'Full Color', category: 'format' },
];

export const TERM_CATEGORIES = [
    { key: 'demographic', label: 'Demographics' },
    { key: 'genre', label: 'Genres' },
    { key: 'theme', label: 'Themes' },
    { key: 'format', label: 'Formats' },
] as const;

export const TYPES = ['manga', 'manhwa', 'manhua', 'other'] as const;
export type MangaType = (typeof TYPES)[number];

export const STATUSES = ['releasing', 'finished', 'on_hiatus', 'discontinued', 'not_yet_released'] as const;
export type MangaStatus = (typeof STATUSES)[number];

export const STATUS_LABELS: Record<string, string> = {
    releasing: 'Releasing',
    finished: 'Finished',
    on_hiatus: 'On Hiatus',
    discontinued: 'Discontinued',
    not_yet_released: 'Not Yet Released',
};

export const TYPE_LABELS: Record<string, string> = {
    manga: 'Manga',
    manhwa: 'Manhwa',
    manhua: 'Manhua',
    other: 'Other',
};

export const NSFW_TERM_IDS = [87264, 87265, 87266, 87267, 87268] as const;
