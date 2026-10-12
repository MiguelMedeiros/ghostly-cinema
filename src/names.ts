/**
 * What a file's path says: a film with its year, or an episode of a show with its season and number. Only the names
 * the person gave their files and folders are read; nothing is looked up anywhere.
 *
 *   Films/Inception (2010)/Inception.2010.1080p.BluRay.x264.mp4   → film "Inception" (2010)
 *   Series/The Office/Season 2/The.Office.S02E03.Office.Olympics.mp4 → "The Office" S2 E3 "Office Olympics"
 *   Dark/Temporada 1/01.mp4                                       → "Dark" S1 E1
 */

export const VIDEO_EXTENSIONS = ["mp4", "m4v", "mov", "mkv", "webm", "avi", "wmv", "mpg", "mpeg", "ts", "m2ts", "flv", "3gp", "ogv", "divx"];
/** What Cinema plays today: MP4 and its kin. The rest shows as "needs converting". */
export const PLAYABLE_EXTENSIONS = ["mp4", "m4v", "mov"];
export const SUBTITLE_EXTENSIONS = ["srt", "vtt"];
export const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];

export interface ParsedVideo {
  kind: "film" | "episode";
  title: string;
  year?: number;
  /** Episodes: the show's name, its season (0 for specials) and the episode's number and title. */
  show?: string;
  showYear?: number;
  season?: number;
  episode?: number;
  /** The last episode of a file that holds several (S01E01E02). */
  episodeEnd?: number;
  episodeTitle?: string;
}

export function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function baseName(name: string): string {
  const slash = name.lastIndexOf("/");
  const file = name.slice(slash + 1);
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(0, dot) : file;
}

export function dirName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(0, slash) : "";
}

/** Where a name stops being a title: quality, source, codec and release tags. */
const TAGS = new RegExp(
  "(?:^|[\\s._\\-\\[(])(?:" +
    [
      "2160p", "1080[pi]", "720p", "576p", "480p", "4k", "uhd", "hdr10\\+?", "hdr", "dv", "dovi", "sdr",
      "[xh]\\.?26[45]", "hevc", "avc", "xvid", "divx", "av1", "vp9",
      "blu-?ray", "bd-?rip", "br-?rip", "bd25", "bd50", "dvd-?rip", "dvd-?r?", "web-?dl", "web-?rip", "web", "hdtv", "hd-?rip", "remux", "amzn", "nf", "dsnp", "hmax", "atvp",
      "aac[0-9.]*", "ac3", "e-?ac-?3", "dts(?:-?hd)?", "ddp?[0-9.]*", "truehd", "atmos", "flac", "opus", "mp3", "5\\.1", "7\\.1", "2\\.0",
      "10-?bit", "8-?bit", "proper", "repack", "extended", "unrated", "uncut", "imax", "remastered", "directors\\.?cut",
      "multi", "dual(?:-?audio)?", "dublado", "legendado", "nacional", "subbed", "dubbed", "complete", "completa",
    ].join("|") +
    ")(?=$|[\\s._\\-\\])])",
  "i",
);

/** Names that say nothing about a film: the folder's name is used instead. */
const GENERIC = /^(?:movie|film|filme|video|vídeo|feature|main|title[ _-]?\d*|vts[ _]\d+[ _]\d+|\d{1,3})$/i;
/** Folders that only hold others: never a show's name. */
const CONTAINERS = /^(?:series|séries|tv|tv shows|shows|seriados|films|filmes|movies|videos|vídeos|downloads|desktop|media|mídia|cinema|anime|animes|kids|infantil|documentaries|documentários|\.)$/i;
const SEASON_DIR = /^(?:season|temporada|series|staffel|saison|stagione|s)[\s._-]*(\d{1,2})(?:\s.*)?$/i;
const SPECIALS_DIR = /^(?:specials?|extras?|especiais|especial)$/i;

/** Readable words from a scene name: dots and underscores to spaces, bracketed groups and the release group out. */
export function cleanTitle(raw: string): string {
  let s = raw.replace(/\[[^\]]*\]|\{[^}]*\}/g, " ");
  if (!/\s/.test(s.trim()) || /[._]\S+[._]/.test(s)) s = s.replace(/(?<=\S)[._](?=\S)/g, " ");
  s = s.replace(/_/g, " ");
  // "Mr. Robot" keeps its dot; "Mr Robot" stays as it is.
  s = s.replace(/\(\s*\)/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/^[\s\-–—:,.]+|[\s\-–—:,(]+$/g, "");
  if (s && (s === s.toLowerCase() || s === s.toUpperCase()) && /[a-z]/i.test(s)) {
    s = s.toLowerCase().replace(/(^|\s|-)(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase());
  }
  return s;
}

function cutAtTags(s: string): string {
  const m = TAGS.exec(s);
  return m && m.index > 0 ? s.slice(0, m.index) : s;
}

/** A year in a name, 1900 to next year, and the name before it. */
function splitYear(s: string): { title: string; year?: number } {
  const max = new Date().getFullYear() + 1;
  const re = /(?:^|[\s._\-(\[])((?:19|20)\d{2})(?=$|[\s._\-)\]])/g;
  let found: { index: number; year: number } | undefined;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const year = Number(m[1]);
    if (year <= max && m.index > 0) found = { index: m.index, year };
  }
  if (!found) return { title: s };
  return { title: s.slice(0, found.index), year: found.year };
}

const EPISODE_PATTERNS: RegExp[] = [
  // S01E02, s1e2, S01.E02, S01E01E02, S01E01-E02
  /(?:^|[^a-z0-9])s(\d{1,2})[\s._-]?e(\d{1,4})(?:(?:[\s._-]?e|-)(\d{1,4}))?(?=$|[^0-9])/i,
  // 1x02
  /(?:^|[^a-z0-9])(\d{1,2})x(\d{2,3})(?=$|[^0-9])/i,
  // Season 1 Episode 2, Temporada 1 Episódio 2
  /(?:season|temporada|saison|staffel)[\s._-]*(\d{1,2})[\s._-]*(?:episode|episódio|episodio|ep|épisode|folge)[\s._-]*(\d{1,4})/i,
];

/** The folders of a path, innermost last, with the season a folder names when it names one. */
function folders(path: string): string[] {
  return dirName(path).split("/").filter((f) => f && f !== ".");
}

export function seasonOfFolder(name: string): number | undefined {
  if (SPECIALS_DIR.test(name.trim())) return 0;
  const m = SEASON_DIR.exec(name.trim());
  return m ? Number(m[1]) : undefined;
}

/** The show a file in `dirs` belongs to by its folders: the folder above "Season N", or the folder itself. */
function showFromFolders(dirs: string[]): string | undefined {
  for (let i = dirs.length - 1; i >= 0; i--) {
    if (seasonOfFolder(dirs[i]) !== undefined) continue;
    if (CONTAINERS.test(dirs[i].trim())) return undefined;
    return dirs[i];
  }
  return undefined;
}

export function parseVideoPath(path: string): ParsedVideo {
  const name = baseName(path);
  const dirs = folders(path);
  const inner = dirs[dirs.length - 1];
  const folderSeason = inner !== undefined ? seasonOfFolder(inner) : undefined;

  for (const re of EPISODE_PATTERNS) {
    const m = re.exec(name);
    if (!m) continue;
    const season = Number(m[1]);
    const episode = Number(m[2]);
    const before = name.slice(0, m.index);
    const after = name.slice(m.index + m[0].length);
    const fromName = splitYear(cutAtTags(before));
    const folderShow = showFromFolders(dirs);
    const showRaw = cleanTitle(fromName.title) || (folderShow ? splitYear(cleanTitle(folderShow)).title : "");
    const showYear = fromName.year ?? (folderShow ? splitYear(folderShow).year : undefined);
    const episodeTitle = cleanTitle(cutAtTags(after));
    return {
      kind: "episode",
      title: episodeTitle || `Episode ${episode}`,
      show: cleanTitle(showRaw) || cleanTitle(name),
      ...(showYear && { showYear }),
      season,
      episode,
      ...(m[3] && Number(m[3]) > episode && { episodeEnd: Number(m[3]) }),
      ...(episodeTitle && { episodeTitle }),
    };
  }

  // In a "Season N" folder, a number in the name is the episode: "01.mp4", "Ep 05 - Title.mp4", "Show - 05.mp4".
  if (folderSeason !== undefined) {
    const m = /(?:^|[\s._-])(?:e|ep|episode|episódio|episodio|cap|capítulo)?[\s._-]*(\d{1,3})(?=$|[\s._-])/i.exec(name);
    if (m) {
      const episode = Number(m[1]);
      const folderShow = showFromFolders(dirs) ?? cleanTitle(name.slice(0, m.index));
      const after = cleanTitle(cutAtTags(name.slice(m.index + m[0].length)));
      const { title: show, year } = splitYear(folderShow);
      return {
        kind: "episode",
        title: after || `Episode ${episode}`,
        show: cleanTitle(show),
        ...(year && { showYear: year }),
        season: folderSeason,
        episode,
        ...(after && { episodeTitle: after }),
      };
    }
  }

  // A film: the name up to its year or its first tag; a generic name takes its folder's.
  let { title, year } = splitYear(cutAtTags(name));
  title = cleanTitle(title);
  if (!title || GENERIC.test(title)) {
    const folder = [...dirs].reverse().find((d) => !CONTAINERS.test(d.trim()));
    if (folder) {
      const fromFolder = splitYear(cutAtTags(folder));
      title = cleanTitle(fromFolder.title) || title;
      year ??= fromFolder.year;
    }
  }
  if (year === undefined && inner) year = splitYear(cutAtTags(inner)).year;
  return { kind: "film", title: title || cleanTitle(name) || name, ...(year && { year }) };
}

/** A key that matches the same show written two ways: "The.Office" and "The Office (2005)". */
export function showKey(name: string): string {
  return splitYear(name).title.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
}

const LANGUAGES: Record<string, string> = {
  en: "en", eng: "en", english: "en", inglês: "en", ingles: "en",
  pt: "pt", por: "pt", portuguese: "pt", português: "pt", portugues: "pt", ptbr: "pt-BR", "pt-br": "pt-BR", "pt_br": "pt-BR", pob: "pt-BR", brazilian: "pt-BR",
  es: "es", spa: "es", spanish: "es", español: "es", espanol: "es", espanhol: "es", lat: "es-419", latino: "es-419",
  fr: "fr", fre: "fr", fra: "fr", french: "fr", français: "fr",
  de: "de", ger: "de", deu: "de", german: "de", deutsch: "de",
  it: "it", ita: "it", italian: "it", italiano: "it",
  ja: "ja", jpn: "ja", japanese: "ja", nl: "nl", dut: "nl", nld: "nl", dutch: "nl",
  ru: "ru", rus: "ru", russian: "ru", zh: "zh", chi: "zh", zho: "zh", chinese: "zh", ko: "ko", kor: "ko", korean: "ko",
  ar: "ar", ara: "ar", arabic: "ar", pl: "pl", pol: "pl", tr: "tr", tur: "tr", sv: "sv", swe: "sv", he: "he", heb: "he",
};

/** A three-letter MP4 language (`por`) as a BCP 47 tag (`pt`), or undefined for `und`. */
export function languageTag(code: string): string | undefined {
  return LANGUAGES[code.toLowerCase()];
}

export interface SubtitleName {
  /** The video's base name the subtitle belongs to. */
  base: string;
  /** BCP 47 tag, or undefined when the name says none. */
  lang?: string;
  forced: boolean;
  /** Subtitles for the deaf and hard of hearing. */
  sdh: boolean;
}

/** `Film.2010.pt-BR.forced.srt` → base "Film.2010", pt-BR, forced. */
export function parseSubtitleName(file: string): SubtitleName {
  let parts = baseName(file).split(".");
  let lang: string | undefined;
  let forced = false;
  let sdh = false;
  while (parts.length > 1) {
    const last = parts[parts.length - 1].toLowerCase();
    if (last === "forced" || last === "forçada" || last === "forcada") forced = true;
    else if (last === "sdh" || last === "cc" || last === "hi") sdh = true;
    else if (languageTag(last) && !lang) lang = languageTag(last);
    else break;
    parts = parts.slice(0, -1);
  }
  return { base: parts.join("."), ...(lang && { lang }), forced, sdh };
}

/** Pictures beside a film, in order of preference. */
export function filmPosterNames(base: string): string[] {
  return [`${base}-poster`, `${base}.poster`, base, "poster", "folder", "cover", "movie"].map((n) => n.toLowerCase());
}

/** Pictures in a show's folder. */
export const SHOW_POSTER_NAMES = ["poster", "folder", "cover", "show"];
