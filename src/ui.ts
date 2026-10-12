/**
 * The page: the contact's library as rows of posters, a title's details with its seasons and episodes, the player,
 * and My library, where the person picks the folder they share.
 */
import type { Cinema } from "./app.ts";
import { displayTitle, type CatItem, type CatShow, type Catalogue, type CatSubtitle } from "./catalogue.ts";
import { append, clear, h } from "./dom.ts";
import type { Entry } from "./library.ts";
import { languageTag } from "./names.ts";
import { canPlay, LocalPlayer, StreamPlayer, type PlayerState } from "./player.ts";
import type { Picked } from "./share.ts";
import { languageName, type Strings } from "./strings.ts";
import type { MiniAppApi } from "./vendor/miniApp.ts";

interface Prefs {
  /** The subtitle language chosen last, or "off". */
  sub?: string;
  /** The audio language chosen last (three letters, as in the file). */
  audio?: string;
}

type Tab = "theirs" | "mine";

const minutes = (seconds: number | undefined) => Math.max(1, Math.round((seconds ?? 0) / 60));

export function mountCinema(root: HTMLElement, app: Cinema, api: MiniAppApi, s: Strings, lang: string, inChat: boolean): void {
  let tab: Tab = inChat ? "theirs" : "mine";
  let query = "";
  let prefs: Prefs = {};
  let overlay: HTMLElement | null = null;
  let playing: { dispose(): void } | null = null;
  let frame = 0;
  void api.storage.get("prefs").then((p) => {
    if (p && typeof p === "object" && !Array.isArray(p)) prefs = { sub: typeof p.sub === "string" ? p.sub : undefined, audio: typeof p.audio === "string" ? p.audio : undefined };
  }).catch(() => {});
  const savePrefs = () => void api.storage.set("prefs", { ...(prefs.sub && { sub: prefs.sub }), ...(prefs.audio && { audio: prefs.audio }) }).catch(() => {});

  const peerName = () => app.peer.name ?? s.contact;
  const header = h("header", { class: "top" });
  const main = h("main", { class: "content" });
  const layer = h("div", { class: "layer" });
  root.append(header, main, layer);

  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      render();
    });
  };
  app.onUpdate(schedule);
  app.watch.onUpdate(schedule);
  // While files are read, the count moves in place and the page is drawn again at most every 2 s.
  let lastDraw = 0;
  let later = 0;
  app.share.onUpdate(() => {
    const progress = app.share.progress;
    const line = main.querySelector<HTMLElement>("[data-testid=reading]");
    if (progress && line) {
      const bar = line.querySelector("progress");
      line.firstChild!.textContent = s.reading(progress.done, progress.total);
      if (bar) bar.value = progress.done;
      if (Date.now() - lastDraw < 2000) {
        if (!later) later = window.setTimeout(() => ((later = 0), schedule()), 2000);
        return;
      }
    }
    schedule();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (playing) closePlayer();
    else if (overlay) closeOverlay();
  });

  // ---------------------------------------------------------------- header

  function renderHeader(): void {
    clear(header);
    const tabButton = (t: Tab, label: string) =>
      h("button", { class: `tab${tab === t ? " on" : ""}`, type: "button", "aria-pressed": String(tab === t), onclick: () => ((tab = t), render()) }, label);
    const name = app.peer.name;
    append(header, [
      h("div", { class: "brand" }, h("span", { class: "logo", "aria-hidden": "true" }, "▶"), h("span", { class: "brand-text" }, s.title)),
      h(
        "nav",
        { class: "tabs" },
        inChat && tabButton("theirs", name ? s.theirLibrary(name) : s.theirLibraryNoName),
        tabButton("mine", s.myLibrary),
      ),
      inChat &&
        h("span", { class: `presence${app.peer.open ? " on" : ""}`, title: app.peer.open ? s.contactOnline(peerName()) : s.contactOffline(peerName()), "data-testid": "presence" }),
    ]);
  }

  // ---------------------------------------------------------------- pictures

  /** A poster box: the picture once it arrives, a title card until then (or for good). */
  function poster(id: string, title: string, source: (id: string) => Promise<string | null>, wide = false): HTMLElement {
    const box = h("div", { class: `poster${wide ? " wide" : ""}` }, h("span", { class: "titlecard" }, title));
    const load = () =>
      void source(id).then((url) => {
        if (!url) return;
        const img = h("img", { alt: "", draggable: false });
        img.addEventListener("load", () => box.classList.add("pic"), { once: true });
        img.src = url;
        box.prepend(img);
      });
    if (typeof IntersectionObserver === "function") {
      const io = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          load();
        }
      }, { rootMargin: "200px" });
      io.observe(box);
    } else {
      load();
    }
    return box;
  }

  const theirPicture = (id: string) => app.watch.picture(id);
  const mine = new Map<string, Promise<string | null>>();
  const myPicture = (id: string) => {
    let p = mine.get(id);
    if (!p) {
      p = app.share.picture(id).then((bytes) => {
        if (!bytes) return null;
        let text = "";
        for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return `data:image/jpeg;base64,${btoa(text)}`;
      });
      mine.set(id, p);
    }
    return p;
  };

  // ---------------------------------------------------------------- the contact's library

  function progressOf(item: CatItem): number {
    const p = app.watch.positions.get(item.id);
    if (!p || !p.d) return 0;
    return Math.min(1, p.t / p.d);
  }

  function metaLine(item: CatItem): string {
    const parts: string[] = [];
    if (item.k === "f" && item.y) parts.push(String(item.y));
    if (item.d) parts.push(s.minutes(minutes(item.d)));
    if (item.h) parts.push(item.h >= 1600 ? "4K" : item.h >= 1000 ? "1080p" : item.h >= 700 ? "720p" : "SD");
    return parts.join(" · ");
  }

  function playableHere(item: CatItem): boolean {
    return !item.x && !!item.m && canPlay(item.m);
  }

  function itemCard(item: CatItem, cat: Catalogue, opts: { wide?: boolean; showTitle?: boolean } = {}): HTMLElement {
    const show = item.k === "e" ? cat.shows.find((x) => x.id === item.sh) : undefined;
    const label = item.k === "e" && opts.showTitle ? displayTitle(item, show) : item.k === "e" ? `${s.episode(item.ep!)} · ${item.t}` : item.t;
    const pct = progressOf(item);
    return h(
      "button",
      { class: `card${playableHere(item) ? "" : " dim"}`, type: "button", "data-testid": "card", "data-id": item.id, onclick: () => (item.k === "e" && show ? openShow(show, item) : openFilm(item)) },
      poster(item.p ? item.id : show?.p ? show.id : item.id, item.k === "e" ? (show?.t ?? item.t) : item.t, item.p || show?.p ? theirPicture : async () => null, opts.wide),
      pct > 0 && h("span", { class: "bar" }, h("i", { style: { width: `${Math.round(pct * 100)}%` } })),
      h("span", { class: "label" }, label),
      h("span", { class: "sub" }, metaLine(item)),
    );
  }

  function showCard(show: CatShow, cat: Catalogue): HTMLElement {
    const eps = cat.items.filter((i) => i.sh === show.id);
    const seasons = new Set(eps.map((e) => e.sn)).size;
    return h(
      "button",
      { class: "card", type: "button", "data-testid": "card", "data-id": show.id, onclick: () => openShow(show) },
      poster(show.id, show.t, show.p ? theirPicture : async () => null),
      h("span", { class: "label" }, show.t),
      h("span", { class: "sub" }, `${s.seasons(seasons)} · ${s.episodes(eps.length)}`),
    );
  }

  function row(title: string, cards: HTMLElement[], testid: string): HTMLElement | null {
    if (!cards.length) return null;
    return h("section", { class: "row", "data-testid": testid }, h("h2", {}, title), h("div", { class: "strip" }, ...cards));
  }

  function renderTheirs(): void {
    const cat = app.watch.catalogue;
    const name = peerName();
    if (!cat) {
      main.append(
        h(
          "div",
          { class: "empty", "data-testid": "empty" },
          h("p", { class: "big" }, app.peer.open ? s.noLibrary(name) : s.waitingFor(name)),
          h("p", {}, s.shareYours),
        ),
      );
      return;
    }
    if (!app.peer.open) main.append(h("p", { class: "notice", "data-testid": "away" }, s.offlineBrowse(name)));
    const search = h("input", { class: "search", type: "search", placeholder: s.search, value: query, "aria-label": s.search });
    search.addEventListener("input", () => {
      query = search.value;
      const at = search.selectionStart;
      render();
      const again = main.querySelector<HTMLInputElement>("input.search");
      again?.focus();
      if (again && at !== null) again.setSelectionRange(at, at);
    });
    main.append(search);
    const q = query.trim().toLowerCase();
    const films = cat.items.filter((i) => i.k === "f");
    if (q) {
      const hits = [
        ...cat.shows.filter((x) => x.t.toLowerCase().includes(q)).map((x) => showCard(x, cat)),
        ...films.filter((f) => f.t.toLowerCase().includes(q)).map((f) => itemCard(f, cat)),
      ];
      main.append(hits.length ? h("div", { class: "grid" }, ...hits) : h("p", { class: "notice" }, s.noResults));
      return;
    }
    const cont = app.watch.continueWatching();
    const hero = cont[0] ?? films.find((f) => f.p && playableHere(f));
    if (hero) main.append(heroBanner(hero, cat));
    const recent = [...cat.items]
      .filter((i) => i.at)
      .sort((a, b) => b.at! - a.at!)
      .filter((i, n, all) => i.k === "f" || all.findIndex((x) => x.sh === i.sh) === n)
      .slice(0, 20);
    for (const r of [
      row(s.continueWatching, cont.map((i) => itemCard(i, cat, { showTitle: true })), "row-continue"),
      row(s.recentlyAdded, recent.map((i) => (i.k === "e" ? showCard(cat.shows.find((x) => x.id === i.sh)!, cat) : itemCard(i, cat))), "row-recent"),
      row(s.films, films.map((f) => itemCard(f, cat)), "row-films"),
      row(s.series, cat.shows.map((x) => showCard(x, cat)), "row-series"),
    ]) {
      if (r) main.append(r);
    }
  }

  function heroBanner(item: CatItem, cat: Catalogue): HTMLElement {
    const show = item.k === "e" ? cat.shows.find((x) => x.id === item.sh) : undefined;
    const pictureId = item.p ? item.id : show?.p ? show.id : null;
    const resume = app.watch.resumeAt(item.id);
    // The picture twice: blurred across the banner, and sharp as a poster beside the words.
    return h(
      "section",
      { class: "hero", "data-testid": "hero" },
      pictureId ? poster(pictureId, "", theirPicture, true) : h("div", { class: "poster wide" }),
      h(
        "div",
        { class: "hero-text" },
        pictureId && poster(pictureId, item.k === "e" ? (show?.t ?? item.t) : item.t, theirPicture),
        h(
          "div",
          { class: "hero-words" },
          h("h1", {}, item.k === "e" ? (show?.t ?? item.t) : item.t),
          h("p", { class: "sub" }, item.k === "e" ? displayTitle(item) : metaLine(item)),
          h(
            "div",
            { class: "actions" },
            h("button", { class: "primary", type: "button", disabled: !playableHere(item) || !app.peer.open, onclick: () => play(item, resume) }, resume ? s.resume : s.play),
            h("button", { type: "button", onclick: () => (item.k === "e" && show ? openShow(show, item) : openFilm(item)) }, s.details),
          ),
        ),
      ),
    );
  }

  // ---------------------------------------------------------------- details

  function closeOverlay(): void {
    overlay?.remove();
    overlay = null;
  }

  function sheet(...children: (Node | null | false)[]): HTMLElement {
    closeOverlay();
    const close = h("button", { class: "close", type: "button", "aria-label": s.close, onclick: closeOverlay }, "✕");
    overlay = h("div", { class: "sheet-back", onclick: (e: Event) => e.target === overlay && closeOverlay() }, h("div", { class: "sheet", role: "dialog", "aria-modal": "true", "data-testid": "details" }, close, ...children.filter(Boolean) as Node[]));
    layer.append(overlay);
    close.focus();
    return overlay;
  }

  function why(item: CatItem): string | null {
    if (item.x === "convert") return s.needsConvert;
    if (item.x) return s.damaged;
    if (item.m && !canPlay(item.m)) return s.cannotPlay;
    return null;
  }

  function audioLabel(code: string): string {
    return languageName(languageTag(code) ?? code, lang, s.unknownLanguage);
  }

  function subtitleLabel(sub: CatSubtitle): string {
    return [languageName(sub.l, lang, s.unknownLanguage), sub.f && s.forced, sub.h && s.sdh].filter(Boolean).join(" · ");
  }

  /** The audio track to start with: the one chosen last time, else the first. */
  function defaultAudio(item: CatItem): number {
    const i = prefs.audio ? (item.au ?? []).indexOf(prefs.audio) : -1;
    return i >= 0 ? i : 0;
  }

  /** The subtitle to start with: as chosen last time; else, when the audio is not in the app's language, one that is. */
  function defaultSub(item: CatItem, audio: number): CatSubtitle | null {
    const subs = item.sb ?? [];
    if (prefs.sub === "off") return subs.find((x) => x.f && x.l && x.l.split("-")[0] === lang.split("-")[0]) ?? null;
    if (prefs.sub) {
      const hit = subs.find((x) => !x.f && x.l === prefs.sub) ?? subs.find((x) => !x.f && x.l?.split("-")[0] === prefs.sub!.split("-")[0]);
      if (hit) return hit;
    }
    const audioLang = languageTag(item.au?.[audio] ?? "und");
    const ui = lang.split("-")[0];
    if (audioLang && audioLang.split("-")[0] === ui) return subs.find((x) => x.f && x.l?.split("-")[0] === ui) ?? null;
    return subs.find((x) => !x.f && x.l?.split("-")[0] === ui) ?? null;
  }

  function openFilm(item: CatItem): void {
    const resume = app.watch.resumeAt(item.id);
    const problem = why(item);
    const pct = progressOf(item);
    sheet(
      h("div", { class: "sheet-head" }, poster(item.p ? item.id : "-", item.t, item.p ? theirPicture : async () => null), h(
        "div",
        { class: "sheet-text" },
        h("h1", {}, item.t),
        h("p", { class: "sub" }, metaLine(item)),
        item.au && item.au.length > 1 ? h("p", { class: "sub" }, `${s.audio}: ${item.au.map(audioLabel).join(", ")}`) : null,
        item.sb?.length ? h("p", { class: "sub" }, `${s.subtitles}: ${item.sb.map(subtitleLabel).join(", ")}`) : null,
        pct > 0 && item.d ? h("p", { class: "sub" }, s.left(minutes(item.d * (1 - pct)))) : null,
        problem ? h("p", { class: "problem", "data-testid": "problem" }, problem) : null,
        h(
          "div",
          { class: "actions" },
          h("button", { class: "primary", type: "button", "data-testid": "play", disabled: !!problem || !app.peer.open, onclick: () => play(item, resume) }, resume ? s.resume : s.play),
          resume ? h("button", { type: "button", disabled: !!problem || !app.peer.open, onclick: () => play(item, 0) }, s.fromStart) : null,
        ),
      )),
    );
  }

  function openShow(show: CatShow, focus?: CatItem): void {
    const cat = app.watch.catalogue;
    if (!cat) return;
    const eps = cat.items.filter((i) => i.sh === show.id).sort((a, b) => a.sn! - b.sn! || a.ep! - b.ep!);
    const seasons = [...new Set(eps.map((e) => e.sn!))];
    // The season to show: the one of the episode asked for, else of the last one started, else the first.
    const started = app.watch.continueWatching().find((i) => i.sh === show.id);
    let season = focus?.sn ?? started?.sn ?? seasons[0];
    const list = h("ol", { class: "episodes", "data-testid": "episodes" });
    const fill = () => {
      clear(list);
      for (const ep of eps.filter((e) => e.sn === season)) {
        const problem = why(ep);
        const pct = progressOf(ep);
        list.append(
          h(
            "li",
            {},
            h(
              "button",
              { type: "button", class: `episode${problem ? " dim" : ""}`, "data-testid": "episode", disabled: !!problem || !app.peer.open, onclick: () => play(ep, app.watch.resumeAt(ep.id)) },
              h("span", { class: "num" }, String(ep.ep)),
              h("span", { class: "ep-text" }, h("span", { class: "label" }, ep.t || s.episode(ep.ep!)), h("span", { class: "sub" }, problem ?? (ep.d ? s.minutes(minutes(ep.d)) : ""))),
              pct > 0 && h("span", { class: "bar" }, h("i", { style: { width: `${Math.round(pct * 100)}%` } })),
            ),
          ),
        );
      }
    };
    const picker =
      seasons.length > 1
        ? h(
            "select",
            { "aria-label": s.season(season), onchange: (e: Event) => ((season = Number((e.target as HTMLSelectElement).value)), fill()) },
            ...seasons.map((n) => h("option", { value: String(n), selected: n === season }, s.season(n))),
          )
        : h("h2", {}, s.season(season));
    fill();
    const next = started ?? eps.find((e) => !why(e));
    sheet(
      h("div", { class: "sheet-head" }, poster(show.p ? show.id : "-", show.t, show.p ? theirPicture : async () => null), h(
        "div",
        { class: "sheet-text" },
        h("h1", {}, show.t),
        h("p", { class: "sub" }, `${show.y ? `${show.y} · ` : ""}${s.seasons(seasons.length)} · ${s.episodes(eps.length)}`),
        next && h("div", { class: "actions" }, h("button", { class: "primary", type: "button", disabled: !app.peer.open, onclick: () => play(next, app.watch.resumeAt(next.id)) }, `${started ? s.resume : s.play} · ${displayTitle(next)}`)),
      )),
      picker,
      list,
    );
  }

  // ---------------------------------------------------------------- the player

  function closePlayer(): void {
    playing?.dispose();
    playing = null;
    layer.querySelector(".player")?.remove();
    render();
  }

  function playerShell(title: string, controls: Node[]): { video: HTMLVideoElement; status: HTMLElement; shell: HTMLElement; extra: HTMLElement } {
    closeOverlay();
    playing?.dispose();
    layer.querySelector(".player")?.remove();
    const video = h("video", { controls: true, playsInline: true, "data-testid": "video" });
    const status = h("div", { class: "status", "aria-live": "polite", "data-testid": "status" });
    const extra = h("div", { class: "extra" });
    let idle = 0;
    const shell = h(
      "div",
      { class: "player", "data-testid": "player" },
      video,
      h("div", { class: "bar-top" }, h("button", { type: "button", class: "back", onclick: closePlayer }, `← ${s.back}`), h("span", { class: "now" }, title), ...controls),
      status,
      extra,
    );
    const wake = () => {
      shell.classList.remove("idle");
      clearTimeout(idle);
      idle = window.setTimeout(() => !video.paused && shell.classList.add("idle"), 3000);
    };
    shell.addEventListener("pointermove", wake);
    shell.addEventListener("pointerdown", wake);
    wake();
    layer.append(shell);
    return { video, status, shell, extra };
  }

  function play(item: CatItem, at: number): void {
    const cat = app.watch.catalogue;
    const show = item.k === "e" ? cat?.shows.find((x) => x.id === item.sh) : undefined;
    let audio = defaultAudio(item);
    let sub = defaultSub(item, audio);
    const subSelect = (item.sb?.length ?? 0) > 0
      ? h(
          "select",
          { "aria-label": s.subtitles, "data-testid": "subtitles" },
          h("option", { value: "" }, `${s.subtitles}: ${s.subtitlesOff}`),
          ...item.sb!.map((x) => h("option", { value: x.id, selected: x.id === sub?.id }, `${s.subtitles}: ${subtitleLabel(x)}`)),
        )
      : null;
    const audioSelect = (item.au?.length ?? 0) > 1
      ? h("select", { "aria-label": s.audio, "data-testid": "audio" }, ...item.au!.map((code, i) => h("option", { value: String(i), selected: i === audio }, `${s.audio}: ${audioLabel(code)}`)))
      : null;
    const { video, status, extra } = playerShell(displayTitle(item, show), [subSelect, audioSelect].filter(Boolean) as Node[]);
    let player: StreamPlayer;
    let lastSave = 0;
    const next = app.watch.nextEpisode(item.id);
    let shown = "";
    const onState = (state: PlayerState) => {
      const speed = state.rate > 0 ? s.speed(((state.rate * 8) / 1e6).toFixed(1)) : "";
      const key = `${state.phase}|${state.error ?? ""}|${state.phase === "starting" || state.phase === "buffering" ? speed : ""}`;
      if (key !== shown) {
        shown = key;
        drawStatus(state, speed);
      }
      saveAndNext(state);
    };
    const drawStatus = (state: PlayerState, speed: string) => {
      clear(status);
      status.className = `status ${state.phase}`;
      if (state.phase === "starting" || state.phase === "buffering") {
        status.append(h("span", { class: "spinner" }), state.phase === "starting" ? s.starting : s.buffering, speed ? h("small", {}, ` ${speed}`) : "");
      } else if (state.phase === "error") {
        const message = state.error === "peer-closed" || state.error === "closed" ? s.errorPeerClosed(peerName()) : state.error === "not-picked" ? s.errorNotPicked(peerName()) : state.error === "codec" ? s.cannotPlay : state.error === "convert" ? s.needsConvert : s.errorGeneric;
        status.append(h("p", {}, message), h("button", { type: "button", onclick: () => player.retry() }, s.tryAgain));
      }
    };
    const saveAndNext = (state: PlayerState) => {
      const now = Date.now();
      if (state.time > 0 && state.duration > 0 && (now - lastSave > 5000 || state.phase === "paused" || state.phase === "ended")) {
        lastSave = now;
        void app.watch.savePosition(item.id, state.phase === "ended" ? state.duration : state.time, state.duration);
      }
      // Drawn once when it is due, not at every tick: a button made again under the pointer cannot be pressed.
      const due = !!next && !!state.duration && (state.phase === "ended" || state.duration - state.time < 45);
      if (due !== !!extra.firstChild) {
        clear(extra);
        if (due) extra.append(h("button", { class: "primary next", type: "button", "data-testid": "next", onclick: () => play(next!, app.watch.resumeAt(next!.id)) }, `${s.nextEpisode} ▸`));
      }
    };
    const start = (from: number) => {
      player?.dispose();
      player = new StreamPlayer(video, app.link, item.id, audio, onState);
      playing = { dispose: () => {
        if (video.currentTime > 0 && player) void app.watch.savePosition(item.id, video.currentTime, video.duration || item.d || 0);
        player.dispose();
      } };
      void player.start(from).then(() => sub && player.subtitles(sub, subtitleLabel(sub)).catch(() => {}));
    };
    subSelect?.addEventListener("change", () => {
      sub = item.sb!.find((x) => x.id === subSelect.value) ?? null;
      prefs.sub = sub?.l ?? "off";
      savePrefs();
      void player.subtitles(sub, sub ? subtitleLabel(sub) : "").catch(() => {});
    });
    audioSelect?.addEventListener("change", () => {
      audio = Number(audioSelect.value);
      prefs.audio = item.au![audio];
      savePrefs();
      start(video.currentTime);
    });
    start(at);
  }

  /** The person's own file, here, from the folder picked in this session. */
  function playHere(entry: Entry, file: Blob): void {
    const { video } = playerShell(entry.video.kind === "film" ? entry.video.title : `${entry.video.show} · S${entry.video.season} E${entry.video.episode}`, []);
    const local = new LocalPlayer(video, file);
    playing = local;
    void local.start(0);
  }

  // ---------------------------------------------------------------- my library

  const folderInput = h("input", { type: "file", multiple: true, class: "hidden", "data-testid": "pick-folder", tabindex: -1 });
  folderInput.setAttribute("webkitdirectory", "");
  const filesInput = h("input", { type: "file", multiple: true, class: "hidden", "data-testid": "pick-files", tabindex: -1, accept: "video/*,.mp4,.m4v,.mov,.mkv,.srt,.vtt,.jpg,.jpeg,.png,.webp" });
  root.append(folderInput, filesInput);
  const picked = (input: HTMLInputElement) => {
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (!files.length) return;
    const list: Picked[] = files.map((f) => ({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, file: f }));
    void app.share.pick(list).then(render);
  };
  folderInput.addEventListener("change", () => picked(folderInput));
  filesInput.addEventListener("change", () => picked(filesInput));

  function renderMine(): void {
    const share = app.share;
    const lib = share.lib;
    const pickButtons = (again?: string) =>
      h(
        "div",
        { class: "actions" },
        h("button", { class: "primary", type: "button", "data-testid": "share-folder", onclick: () => folderInput.click() }, again ? s.pickAgain(again) : s.shareFolder),
        h("button", { type: "button", onclick: () => filesInput.click() }, s.shareFiles),
      );
    if (!lib) {
      main.append(
        h(
          "div",
          { class: "empty", "data-testid": "share-empty" },
          h("p", { class: "big" }, inChat ? s.shareExplain(peerName()) : s.alone),
          h("p", {}, s.sharePrivacy),
          pickButtons(),
        ),
      );
      return;
    }
    const toConvert = [...lib.films, ...lib.episodes].filter((e) => !e.container || share.scan(e.id)?.x);
    main.append(
      h(
        "section",
        { class: "mine-head" },
        h("h1", {}, share.folder ?? s.myLibrary),
        h("p", { class: "sub" }, s.libraryCounts(lib.films.length, lib.shows.length, lib.episodes.length), inChat ? ` · ${s.sharedWith(peerName())}` : ""),
        share.progress && h("p", { class: "notice", "data-testid": "reading" }, s.reading(share.progress.done, share.progress.total), h("progress", { max: share.progress.total, value: share.progress.done })),
        !share.linked && h("p", { class: "notice", "data-testid": "pick-again" }, s.pickAgainExplain),
        !share.linked ? pickButtons(share.folder) : null,
      ),
    );
    const card = (e: Entry, title: string, sub: string, pictureId: string | null) =>
      h(
        "button",
        { class: `card${e.container && !share.scan(e.id)?.x ? "" : " dim"}`, type: "button", "data-testid": "my-card", disabled: !share.has(e.id), onclick: () => {
          const file = share.file(e.path);
          if (file) playHere(e, file);
        } },
        poster(pictureId ?? "-", title, pictureId ? myPicture : async () => null),
        h("span", { class: "label" }, title),
        h("span", { class: "sub" }, sub),
      );
    const films = lib.films.map((e) => card(e, e.video.title, [e.video.year, share.scan(e.id)?.d && s.minutes(minutes(share.scan(e.id)!.d))].filter(Boolean).join(" · "), share.scan(e.id)?.p ? e.id : null));
    const shows = lib.shows.map((show) => {
      const eps = lib.episodes.filter((e) => e.showId === show.id);
      const first = eps[0];
      const pic = share.showHasPicture(show.id) ? show.id : null;
      return card(first, show.title, s.episodes(eps.length), pic);
    });
    for (const r of [row(s.films, films, "my-films"), row(s.series, shows, "my-series")]) if (r) main.append(r);
    if (toConvert.length) {
      main.append(
        h(
          "section",
          { class: "convert", "data-testid": "convert" },
          h("h2", {}, s.toConvert(toConvert.length)),
          h("p", { class: "sub" }, s.convertHint),
          h("pre", {}, toConvert.slice(0, 50).map((e) => `ffmpeg -i "${e.path.split("/").pop()}" -c copy "${e.path.split("/").pop()!.replace(/\.[^.]+$/, "")}.mp4"`).join("\n")),
        ),
      );
    }
    // The sandbox allows no confirm(): the question is asked in the page.
    const stop = h("div", { class: "actions end" });
    const ask = () => {
      clear(stop);
      stop.append(
        h("p", { class: "sub" }, s.stopSharingConfirm),
        h("button", { type: "button", class: "danger", "data-testid": "stop-yes", onclick: () => void app.share.forget().then(render) }, s.stopSharing),
        h("button", { type: "button", onclick: render }, s.close),
      );
    };
    stop.append(h("button", { type: "button", class: "quiet", "data-testid": "stop", onclick: ask }, s.stopSharing));
    main.append(stop);
  }

  // ---------------------------------------------------------------- all

  function render(): void {
    lastDraw = Date.now();
    renderHeader();
    const scroll = main.scrollTop;
    clear(main);
    if (tab === "theirs") renderTheirs();
    else renderMine();
    main.scrollTop = scroll;
  }

  render();
}
