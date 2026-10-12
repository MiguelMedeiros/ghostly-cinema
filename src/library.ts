/**
 * The library a person shares: built from the files of the folder they picked, by their paths alone. Films, shows
 * with their seasons and episodes, the subtitles and pictures beside them. Ids come from paths, so picking the same
 * folder again gives the same ids, and the contact's place in a film still holds.
 */
import {
  baseName, dirName, extension, filmPosterNames, IMAGE_EXTENSIONS, parseSubtitleName, parseVideoPath, PLAYABLE_EXTENSIONS,
  seasonOfFolder, SHOW_POSTER_NAMES, showKey, SUBTITLE_EXTENSIONS, VIDEO_EXTENSIONS, type ParsedVideo,
} from "./names.ts";

export interface PickedFile {
  /** Relative to the folder picked, `/`-separated, the picked folder's own name first (as `webkitRelativePath`). */
  path: string;
  size: number;
  modified: number;
}

export interface Subtitle {
  id: string;
  path: string;
  lang?: string;
  forced: boolean;
  sdh: boolean;
}

export interface Entry {
  id: string;
  path: string;
  size: number;
  modified: number;
  /** Lower case, without the dot. */
  ext: string;
  /** Cinema can play it as it is (MP4, M4V, MOV); the others need converting first. */
  container: boolean;
  video: ParsedVideo;
  showId?: string;
  subtitles: Subtitle[];
  /** A picture beside it: a film's poster, or an episode's still (`<name>-thumb.jpg`). */
  picture?: string;
}

export interface Show {
  id: string;
  title: string;
  year?: number;
  poster?: string;
}

export interface Library {
  films: Entry[];
  episodes: Entry[];
  shows: Show[];
  /** Files left out: samples and trailers. */
  skipped: number;
}

/** A 53-bit hash (cyrb53) in base 36: ids from paths. */
export function hashId(text: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const SKIP = /(?:^|[\s._\-\[(])(?:sample|trailer|teaser|featurette|behind[\s._-]the[\s._-]scenes)(?=$|[\s._\-\])])/i;
const SUB_FOLDERS = /^(?:subs?|subtitles?|legendas?)$/i;

function hidden(path: string): boolean {
  return path.split("/").some((part) => part.startsWith(".") || part === "__MACOSX" || part === "$RECYCLE.BIN");
}

const lower = (s: string) => s.toLowerCase();

export function buildLibrary(files: PickedFile[]): Library {
  const visible = files.filter((f) => !hidden(f.path));
  const byDir = new Map<string, PickedFile[]>();
  for (const f of visible) {
    const dir = dirName(f.path);
    byDir.set(dir, [...(byDir.get(dir) ?? []), f]);
  }
  const isVideo = (f: PickedFile) => VIDEO_EXTENSIONS.includes(extension(f.path));
  const isImage = (f: PickedFile) => IMAGE_EXTENSIONS.includes(extension(f.path));
  const isSub = (f: PickedFile) => SUBTITLE_EXTENSIONS.includes(extension(f.path));

  let skipped = 0;
  const videos = visible.filter((f) => {
    if (!isVideo(f)) return false;
    // A sample or a trailer beside the film: left out (a film called "Trailer Park Boys" is long enough to stay).
    if (SKIP.test(baseName(f.path)) && f.size < 400 * 1024 * 1024) {
      skipped++;
      return false;
    }
    return true;
  });

  const imageIn = (dir: string, names: string[]): string | undefined => {
    const images = (byDir.get(dir) ?? []).filter(isImage);
    for (const name of names) {
      const hit = images.find((i) => lower(baseName(i.path)) === name);
      if (hit) return hit.path;
    }
    return undefined;
  };

  const subtitlesFor = (video: PickedFile): Subtitle[] => {
    const dir = dirName(video.path);
    const base = lower(baseName(video.path));
    const out: Subtitle[] = [];
    const add = (f: PickedFile, langHint?: string) => {
      const parsed = parseSubtitleName(f.path);
      const lang = parsed.lang ?? langHint;
      out.push({ id: hashId(f.path), path: f.path, ...(lang && { lang }), forced: parsed.forced, sdh: parsed.sdh });
    };
    for (const f of (byDir.get(dir) ?? []).filter(isSub)) {
      if (lower(parseSubtitleName(f.path).base) === base) add(f);
    }
    // Subs/<name>.srt and Subs/<name>/<n>_English.srt beside the video.
    for (const [d, list] of byDir) {
      if (dirName(d) === dir && SUB_FOLDERS.test(d.slice(d.lastIndexOf("/") + 1))) {
        for (const f of list.filter(isSub)) if (lower(parseSubtitleName(f.path).base) === base) add(f);
      }
      const parent = dirName(d);
      if (dirName(parent) === dir && SUB_FOLDERS.test(parent.slice(parent.lastIndexOf("/") + 1)) && lower(d.slice(d.lastIndexOf("/") + 1)) === base) {
        for (const f of list.filter(isSub)) {
          const words = baseName(f.path).replace(/^\d+[_\s.-]*/, "");
          add(f, parseSubtitleName(`x.${words}.srt`).lang);
        }
      }
    }
    return out.sort((a, b) => Number(a.forced) - Number(b.forced) || (a.lang ?? "~").localeCompare(b.lang ?? "~"));
  };

  const films: Entry[] = [];
  const episodes: Entry[] = [];
  const showNames = new Map<string, { names: Map<string, number>; year?: number; dirs: Set<string> }>();

  for (const f of videos) {
    const video = parseVideoPath(f.path);
    const ext = extension(f.path);
    const entry: Entry = {
      id: hashId(f.path),
      path: f.path,
      size: f.size,
      modified: f.modified,
      ext,
      container: PLAYABLE_EXTENSIONS.includes(ext),
      video,
      subtitles: subtitlesFor(f),
    };
    const dir = dirName(f.path);
    const base = lower(baseName(f.path));
    if (video.kind === "film") {
      const alone = (byDir.get(dir) ?? []).filter(isVideo).filter((v) => !SKIP.test(baseName(v.path))).length === 1;
      const picture = imageIn(dir, alone ? filmPosterNames(base) : filmPosterNames(base).slice(0, 3));
      if (picture) entry.picture = picture;
      films.push(entry);
      continue;
    }
    const key = showKey(video.show ?? video.title);
    entry.showId = hashId(`show:${key}`);
    const still = imageIn(dir, [`${base}-thumb`, `${base}.thumb`, base]);
    if (still) entry.picture = still;
    episodes.push(entry);
    const show = showNames.get(key) ?? { names: new Map<string, number>(), dirs: new Set<string>() } as { names: Map<string, number>; year?: number; dirs: Set<string> };
    show.names.set(video.show!, (show.names.get(video.show!) ?? 0) + 1);
    show.year ??= video.showYear;
    // The show's own folder: above "Season N", or the episode's folder when it is named for the show.
    const dirs = dir.split("/");
    const inner = dirs[dirs.length - 1] ?? "";
    if (seasonOfFolder(inner) !== undefined) show.dirs.add(dirName(dir));
    else if (showKey(inner) === key) show.dirs.add(dir);
    showNames.set(key, show);
  }

  const shows: Show[] = [...showNames].map(([key, s]) => {
    const title = [...s.names].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
    let poster: string | undefined;
    for (const dir of s.dirs) poster ??= imageIn(dir, SHOW_POSTER_NAMES);
    return { id: hashId(`show:${key}`), title, ...(s.year && { year: s.year }), ...(poster && { poster }) };
  });

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  films.sort((a, b) => collator.compare(a.video.title, b.video.title) || (a.video.year ?? 0) - (b.video.year ?? 0));
  const showTitle = new Map(shows.map((s) => [s.id, s.title]));
  episodes.sort(
    (a, b) =>
      collator.compare(showTitle.get(a.showId!) ?? "", showTitle.get(b.showId!) ?? "") ||
      (a.video.season ?? 0) - (b.video.season ?? 0) ||
      (a.video.episode ?? 0) - (b.video.episode ?? 0) ||
      collator.compare(a.path, b.path),
  );
  shows.sort((a, b) => collator.compare(a.title, b.title));
  return { films, episodes, shows, skipped };
}
