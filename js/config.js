export const firebaseConfig = {
  apiKey: "AIzaSyDfDJaUGKPEh8udbup0g66uIWaz6uPbvRQ",
  authDomain: "album-rating-9efaa.firebaseapp.com",
  projectId: "album-rating-9efaa",
  storageBucket: "album-rating-9efaa.firebasestorage.app",
  messagingSenderId: "1051785148040",
  appId: "1:1051785148040:web:40caab005218009126513d"
};
export const ADMIN_UID = "raYJInjPDLOvflxoaVvoKrbBsUc2";
export const ITUNES_PROXY = "https://album-rating-proxy.duckdns.org/api/proxy";

export const FINAL_MAX = 360;
export const MAX_TRACKS = 30;
export const DEBOUNCE_MS = 400;
export const SEARCH_CACHE_TTL = 30 * 60 * 1000;
export const RELEASE_CACHE_TTL = 60 * 60 * 1000;
export const MAINTENANCE_DEFAULT_MSG = "Обновляем сайт, скоро вернёмся";
export const NOW_PLAYING_TTL = 24 * 60 * 60 * 1000;
export const RATE_LIMIT_MS = 5000;
export const RATE_LIMIT_HOUR = 30;
export const BOARD_PAGE_SIZE = 50;
export const FEED_PAGE_SIZE = 30;
export const FEED_MAX_ITEMS = 150;
export const SCHEME_KEY = "albumRating_scheme_v1";
export const REPORT_THRESHOLD = 5;

export const LS_THEME  = "albumRating_theme_v12";
export const LS_MODE   = "albumRating_mode_v12";
export const LS_SOURCE = "albumRating_source_v12";
export const LS_DRAFT  = "albumRating_draft_v12";
export const LS_SEARCH_CACHE = "albumRating_searchCache_v12";
export const LS_RELEASE_CACHE = "albumRating_releaseCache_v12";
export const LS_RATING_TIMES = "albumRating_ratingTimes_v12";
export const LS_ANNOUNCEMENT = "albumRating_announcement_v1";
export const LS_REPORTS = "albumRating_myReports_v1";

export const TIERS = [
  { min: 0.00,  max: 0.15,  emoji: "⚫", name: "Уголь",     cssClass: "tier-coal",    medal: "tier-medal-coal",    color: "var(--coal)" },
  { min: 0.15,  max: 0.30,  emoji: "🥉", name: "Бронза",    cssClass: "tier-bronze",  medal: "tier-medal-bronze",  color: "var(--bronze)" },
  { min: 0.30,  max: 0.45,  emoji: "⚪", name: "Серебро",   cssClass: "tier-silver",  medal: "tier-medal-silver",  color: "var(--silver)" },
  { min: 0.45,  max: 0.60,  emoji: "🏅", name: "Золото",    cssClass: "tier-gold",    medal: "tier-medal-gold",    color: "var(--gold-lvl)" },
  { min: 0.60,  max: 0.75,  emoji: "💠", name: "Платина",   cssClass: "tier-plat",    medal: "tier-medal-plat",    color: "var(--plat)" },
  { min: 0.75,  max: 0.90,  emoji: "🔴", name: "Рубин",     cssClass: "tier-ruby",    medal: "tier-medal-ruby",    color: "var(--ruby)" },
  { min: 0.90,  max: 0.999, emoji: "💎", name: "Алмаз",     cssClass: "tier-diamond", medal: "tier-medal-diamond", color: "var(--diamond)" },
  { min: 0.999, max: 2.00,  emoji: "👑", name: "Бриллиант", cssClass: "tier-brill",   medal: "tier-medal-brill",   color: "var(--brill)" }
];

export const LEVELS = [
  { level: 1,  name: "Новичок",         emoji: "🎧", xp: 0 },
  { level: 2,  name: "Слушатель",       emoji: "🎵", xp: 50 },
  { level: 3,  name: "Ценитель",        emoji: "🎼", xp: 150 },
  { level: 4,  name: "Знаток",          emoji: "🎤", xp: 350 },
  { level: 5,  name: "Эксперт",         emoji: "🎸", xp: 700 },
  { level: 6,  name: "Мастер звука",    emoji: "🎹", xp: 1200 },
  { level: 7,  name: "Ритм-мастер",     emoji: "🥁", xp: 2000 },
  { level: 8,  name: "Гармонист",       emoji: "🎺", xp: 3200 },
  { level: 9,  name: "Виртуоз",         emoji: "🎻", xp: 5000 },
  { level: 10, name: "Джазмен",         emoji: "🎷", xp: 7500 },
  { level: 11, name: "Продюсер",        emoji: "🎬", xp: 11000 },
  { level: 12, name: "Радиоведущий",    emoji: "📻", xp: 16000 },
  { level: 13, name: "Аудиофил",        emoji: "💿", xp: 22000 },
  { level: 14, name: "Импресарио",      emoji: "🎩", xp: 30000 },
  { level: 15, name: "Критик",          emoji: "🏆", xp: 40000 },
  { level: 16, name: "Маэстро",         emoji: "👑", xp: 55000 },
  { level: 17, name: "Легенда",         emoji: "💎", xp: 75000 },
  { level: 18, name: "Гуру",            emoji: "🌟", xp: 100000 },
  { level: 19, name: "Оракул",          emoji: "🔮", xp: 150000 },
  { level: 20, name: "Бессмертный",     emoji: "🦄", xp: 250000 }
];

export const XP_REWARDS = {
  rating: 10, detailedTrack: 5, comment: 3,
  suggestionApproved: 25, dailyLogin: 2,
  weekStreak: 20, monthStreak: 100,
  firstOfDay: 5, achievement: 15
};



export const VERDICTS_ALBUM = {
  "Уголь": "Забудь и не вспоминай",
  "Бронза": "Есть моменты, но в целом мимо",
  "Серебро": "Середнячок с проблесками",
  "Золото": "Хороший альбом, к нему вернёшься",
  "Платина": "Отличный, много сильных треков",
  "Рубин": "Почти шедевр, редкие слабинки",
  "Алмаз": "Крепкий шедевр, слушать и слушать",
  "Бриллиант": "Идеальный альбом. Без единой слабины."
};
export const VERDICTS_SINGLE = {
  "Уголь": "Забудь и не вспоминай",
  "Бронза": "Есть за что зацепиться, но сыро",
  "Серебро": "Неплохо, но чего-то не хватает",
  "Золото": "Хороший трек, можно переслушать",
  "Платина": "Отличный трек, один из лучших",
  "Рубин": "Почти шедевр, редкие недочёты",
  "Алмаз": "Крепкий хит, слушать и слушать",
  "Бриллиант": "Идеальный трек. Без единой слабины."
};
export const VERDICTS_TRACK = {
  "Уголь": "Слабое место альбома",
  "Бронза": "Проходной трек",
  "Серебро": "Средний трек",
  "Золото": "Хороший трек",
  "Платина": "Сильный трек",
  "Рубин": "Один из лучших в альбоме",
  "Алмаз": "Хит альбома",
  "Бриллиант": "Жемчужина альбома"
};

export const TRACK_CRITERIA = [
  { key: "rhymes",    emoji: "🖋", name: "Рифмы / образы" },
  { key: "structure", emoji: "🎼", name: "Структура / ритмика" },
  { key: "style",     emoji: "🎭", name: "Реализация стиля" },
  { key: "charisma",  emoji: "⚡", name: "Индивидуальность / харизма" },
  { key: "vibe",      emoji: "🌌", name: "Атмосфера / вайб" }
];
export const VIBE_KEY = "vibe";
export const MAIN_CRITERIA = TRACK_CRITERIA.filter(c => c.key !== VIBE_KEY);

export const EMOJI_AVATARS = [
  "🎵","🎸","🎤","🎧","🎹","🥁","🎺","🎻","🎷","🪕",
  "🔥","💎","👑","⭐","🌙","☀️","⚡","🌈","❄️","🌊",
  "🎨","📀","💿","📻","🎬","🎮","🕹","🎯","🏆","🥇",
  "🦊","🐺","🐱","🐶","🦁","🐯","🐻","🐼","🦉","🐸",
  "🚀","🛸","🌌","🌠","🪐","🧊","🍀","🍕","☕","🍺"
];

export const SCHEMES = [
  { id: "default", name: "Ночь",   class: "",              preview: "sc-preview-default" },
  { id: "ocean",   name: "Океан",  class: "scheme-ocean",  preview: "sc-preview-ocean" },
  { id: "sunset",  name: "Закат",  class: "scheme-sunset", preview: "sc-preview-sunset" },
  { id: "forest",  name: "Лес",    class: "scheme-forest", preview: "sc-preview-forest" },
  { id: "berry",   name: "Ягода",  class: "scheme-berry",  preview: "sc-preview-berry" },
  { id: "mono",    name: "Моно",   class: "scheme-mono",   preview: "sc-preview-mono" }
];

export const ACHIEVEMENTS = [
  { id: "first_step",   emoji: "🎯", name: "Первый шаг",        desc: "Поставить первую оценку" },
  { id: "listener",     emoji: "🎧", name: "Слушатель",         desc: "Оценить 5 релизов" },
  { id: "melomaniac",   emoji: "🎼", name: "Меломан",           desc: "Оценить 15 релизов" },
  { id: "collector",    emoji: "🎩", name: "Коллекционер",      desc: "Оценить 50 релизов" },
  { id: "maestro",      emoji: "👑", name: "Маэстро",           desc: "Оценить 100 релизов" },
  { id: "lvl_bronze",   emoji: "🥉", name: "Бронзовый",         desc: "Оценка в диапазоне Бронза" },
  { id: "lvl_gold",     emoji: "💛", name: "Золотой",           desc: "Оценка в диапазоне Золото" },
  { id: "lvl_diamond",  emoji: "💎", name: "Алмазный",          desc: "Оценка в диапазоне Алмаз" },
  { id: "lvl_brill",    emoji: "👑", name: "Бриллиантовый",     desc: "Поставить оценку 360" },
  { id: "lvl_coal",     emoji: "⚫", name: "Не проникся",       desc: "Оценка в диапазоне Уголь" },
  { id: "fan",          emoji: "🎤", name: "Верный фанат",      desc: "3 релиза одного артиста" },
  { id: "superfan",     emoji: "🏆", name: "Преданный фанат",   desc: "10 релизов одного артиста" },
  { id: "traveler",     emoji: "🌍", name: "Путешественник",    desc: "10 разных артистов" },
  { id: "cartographer", emoji: "🗺", name: "Картограф",         desc: "50 разных артистов" },
  { id: "diverse",      emoji: "🎲", name: "Разнообразный",     desc: "Альбом + сингл + трек" },
  { id: "night",        emoji: "🌙", name: "Ночной критик",     desc: "Оценка с 00:00 до 06:00" },
  { id: "early",        emoji: "☀️", name: "Ранняя пташка",     desc: "Оценка с 06:00 до 09:00" },
  { id: "statistician", emoji: "📊", name: "Статистик",         desc: "10 релизов с подробной оценкой" },
  { id: "speedrun",     emoji: "⚡", name: "Скоростной",        desc: "5 релизов за день" },
  { id: "perfectionist",emoji: "🎨", name: "Перфекционист",     desc: "10 трекам по 10" },
  { id: "lazy",         emoji: "😴", name: "Ленивый",           desc: "Оценить, не открывая треки" },
  { id: "pioneer",      emoji: "🥇", name: "Первопроходец",     desc: "Первая оценка на доске" },
  { id: "regular",      emoji: "📅", name: "Регулярный",        desc: "7 дней подряд" },
  { id: "permanent",    emoji: "📆", name: "Постоянный",        desc: "30 дней подряд" },
  { id: "critic",       emoji: "🎯", name: "Критик",            desc: "10 оценок ниже 100" },
  { id: "generous",     emoji: "🌟", name: "Щедрый",            desc: "10 оценок выше 300" },
  { id: "comparer",     emoji: "🏅", name: "Сравнитель",        desc: "Использовать сравнение" },
  { id: "perfect_taste",emoji: "🎩", name: "Идеальный вкус",    desc: "Все оценки выше Золота" },
  { id: "rebel",        emoji: "🎪", name: "Бунтарь",           desc: "Оценка отличается от средней на 100+" },
  { id: "brill_hunter", emoji: "💎", name: "Коллекционер бриллиантов", desc: "10 оценок по 360" },
  { id: "all_colors",   emoji: "🌈", name: "Все цвета",         desc: "Все 8 диапазонов" },
  { id: "dawn",         emoji: "🌄", name: "Рассвет",           desc: "Оценка в 05:00–07:00" },
  { id: "evening",      emoji: "🌆", name: "Вечер",             desc: "Оценка в 20:00–23:00" },
  { id: "weekend",      emoji: "📆", name: "Выходной",          desc: "5 релизов за выходные" },
  { id: "round",        emoji: "🔢", name: "Ровные цифры",      desc: "Оценка ровно 200 или 300" },
  { id: "century",      emoji: "💯", name: "Круглая дата",      desc: "100-я оценка на сайте" },
  { id: "sniper",       emoji: "🎯", name: "Снайпер",           desc: "Совпала с итоговой средней" },
  { id: "fair",         emoji: "⚖", name: "Справедливый",      desc: "Все оценки в диапазоне 100–250" },
  { id: "growing",      emoji: "📈", name: "Растущий",          desc: "Последние 5 выше предыдущих 5" },
  { id: "company",      emoji: "👥", name: "Компания",          desc: "Релиз оценили 3+ человека одновременно" },
  { id: "polemist",     emoji: "💬", name: "Полемист",          desc: "Отличается от средней на 50+" },
  { id: "agree",        emoji: "🤝", name: "Согласный",         desc: "Совпала с оценкой админа" },
  { id: "protege",      emoji: "👑", name: "Протеже",           desc: "5 оценок потом оценил админ" },
  { id: "unique",       emoji: "🦄", name: "Уникальный",        desc: "Единственный в своём тире" },
  { id: "cosmos",       emoji: "🌌", name: "Космос",            desc: "Оценка 360" },
  { id: "antifan",      emoji: "💀", name: "Антифанат",         desc: "3 оценки ниже 50" },
  { id: "master",       emoji: "🧙", name: "Мастер",            desc: "Открыть 40 достижений" },
  { id: "clown",        emoji: "🤡", name: "Клоун",             desc: "Оценка 42" },
  { id: "cat",          emoji: "🐱", name: "Кот",               desc: "Релиз с котом на обложке" },
  { id: "pizza",        emoji: "🍕", name: "Пицца",             desc: "Релиз про еду в названии" },
  { id: "random",       emoji: "🎲", name: "Рандом",            desc: "5 разных оценок за минуту" },
  { id: "cold",         emoji: "🧊", name: "Холодный",          desc: "30 дней без комментариев" },
  { id: "aesthete",     emoji: "🎨", name: "Эстет",             desc: "10 обложек оценено на 10" },
  { id: "visualist",    emoji: "🖼", name: "Визуалист",         desc: "Средняя по обложкам выше 8 (мин. 10 оценок)" },
  { id: "photographer", emoji: "📸", name: "Фотограф",          desc: "Оценил обложку на 10 у 5 разных релизов" }
];
// ============================================================
// ОЦЕНКА АРТИСТОВ
// ============================================================

export const ARTIST_CRITERIA = [
  { key: "vocals",      emoji: "🎤", name: "Вокал / техника" },
  { key: "lyrics",      emoji: "🖋", name: "Тексты / смысл" },
  { key: "music",       emoji: "🎼", name: "Музыка / композиция" },
  { key: "uniqueness",  emoji: "🌟", name: "Уникальность / стиль" },
  { key: "charisma",    emoji: "🎭", name: "Харизма / образ" },
  { key: "vibe",        emoji: "🌌", name: "Атмосфера / вайб" }
];

export const ARTIST_VIBE_KEY = "vibe";
export const ARTIST_MAIN_CRITERIA = ARTIST_CRITERIA.filter(c => c.key !== ARTIST_VIBE_KEY);

export const VERDICTS_ARTIST = {
  "Уголь":     "Забудь и не вспоминай",
  "Бронза":    "Есть моменты, но в целом мимо",
  "Серебро":   "Середнячок с проблесками",
  "Золото":    "Хороший артист, к нему вернёшься",
  "Платина":   "Отличный, много сильных работ",
  "Рубин":     "Почти легенда, редкие слабинки",
  "Алмаз":     "Один из лучших. Слушать и слушать",
  "Бриллиант": "Легенда. Идеальный артист."
};