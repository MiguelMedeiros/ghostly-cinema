# Ghostly Cinema

Your own films and series as a library you share with a contact in a [Ghostly](https://github.com/MiguelMedeiros/ghostly)
chat. Pick the folder that holds them: Cinema shows them with posters, seasons and episodes, and your contact streams any
title from your device, peer to peer, while you both have Cinema open in the chat. Seeking, resume where you stopped,
subtitles (`.srt`, `.vtt`) and audio languages. Useful when travelling.

Only your own files: Cinema searches nothing, downloads nothing and looks nothing up online. Titles come from the
files' and folders' names; pictures from files beside them (`poster.jpg`, `folder.jpg`, `<name>.jpg`,
`<name>-thumb.jpg`) or a frame of the video.

Cinema is a Ghostly mini-app ([WISP 1200](https://github.com/MiguelMedeiros/ghostly/blob/dev/docs/wisps/1200-marketplace.md)):
one self-contained HTML file that runs in the client's sandbox, full screen (`view: full`), with the `chat` and `name`
permissions and no network. It talks to Ghostly only through `window.ghostly`: `apps/1` frames to the same app on the
contact's side, and storage per app and per chat. The UI speaks English and Brazilian Portuguese (`src/strings.ts`).

## How a film reaches the contact

1. **Picking.** The person picks a folder in the app (`<input webkitdirectory>`). The app gets `File` objects and reads
   ranges with `slice`: nothing is copied or held whole. Ghostly apps cannot keep access to a folder yet, so after the
   app closes the folder is picked again; the library, its pictures and what was read from each file stay in the
   chat's storage, so the contact still browses meanwhile.
2. **Reading a film** (`src/media/mp4.ts`). The `moov` is found with a few ranged reads (often at the end), its sample
   tables indexed, and the film is cut into fragmented MP4 on demand: an init segment, then about 1 MiB of samples at a
   time from any keyframe. A QuickTime sound entry (`.mov`) is written as an ISO one. MKV, AVI and the rest show as
   "needs converting", with the `ffmpeg -c copy` line to do it losslessly.
3. **The wire** (`src/link.ts`, [docs/protocol.md](docs/protocol.md)). The contact pulls: `get` a catalogue, a
   picture, an init segment, a fragment or a subtitle; the answer comes as base64 chunks of 24,480 bytes, acknowledged,
   a window of them in flight, at most 44 frames a second (the broker takes 48): a ceiling of about 8.8 Mbit/s. A frame refused because the channel is
   full (`offline` while the contact is still open) is sent again and the window shrinks.
4. **The player** (`src/player.ts`). Media Source, attached with `video.srcObject` in WebKit and a `blob:` URL in
   Chromium (measured in the runner's sandbox: each engine refuses the other way). It keeps 60 s ahead; a seek outside
   what it holds drops the request under way and asks for the fragment at the new time.

What it cannot do with today's app API, and what Ghostly would need (proposed in
[ghostly-agents#661](https://github.com/MiguelMedeiros/ghostly-agents/issues/661)): keep access to a folder (linked
files), a binary read lane to the contact outside the chat's 32 KiB JSON frames (today's ceiling is about 9 Mbit/s on a
direct link and less through a relay), sending a film ahead for offline watching, and full screen.

## Build

Node 22 or later.

```sh
npm ci
npm run typecheck
npm test          # names, the library, MP4 to fragments (read back with ffprobe where installed), the link, two sides on a mock broker, the bundle
npm run build     # dist/index.html, the whole app in one file
npm run dev       # a dev server; outside Ghostly it runs alone on a stand-in broker that keeps nothing
npm run test:browser   # the built page in Chromium and WebKit (npx playwright install chromium webkit once)
```

`npm run test:browser` runs two sides of one chat, each in `<iframe sandbox="allow-scripts">` served with the web
runner's CSP header (an opaque origin, `media-src data: blob:`), relayed through Node with the broker's limits: Miguel
picks a folder, Ana sees his library, plays a film that streams over the relay, seeks into the part never sent, turns
on subtitles, finds it under Continue watching, and after Miguel's app reloads a film waits for the folder again. An
episode plays its next one, a MOV plays in Chromium, and the layout fits from a 320 px phone to a wide window.

The test videos in `test/fixtures` are made by `npm run gen:fixtures` (ffmpeg) and committed.
The icon, `assets/icon.png`, is drawn by `npm run gen:icon` (`scripts/icon.mjs`) and committed; `test/icon.test.ts`
holds the two equal.

### Checked by hand

Playwright's WebKit is not Safari, WKWebView or WebKitGTK. Before a release, check these by hand, with the client
versions, in the release's pull request or issue:

- **Desktop (macOS, WKWebView):** "Share a folder" opens the system's folder picker in the app window, and a picked
  folder's films get pictures; a contact's film plays and seeks (Media Source by `srcObject`).
- **Desktop (Linux, WebKitGTK):** the same, and a film plays (WebKitGTK's Media Source over GStreamer).
- **Safari and the iPhone's web app:** a contact's film plays (`ManagedMediaSource` on the iPhone) and subtitles show.
- **A real film between two devices:** a 1–2 GB MP4 plays within a few seconds on a direct link and seeks; the rate
  the player shows is noted with the link (direct or relayed).

`npm run digest` prints the built file's SHA-256 in the form a signed bundle lists it. The build is reproducible (the
bundler is pinned in `overrides`), and `test/bundle.test.ts` builds twice to check it.

## Publishing

[docs/PUBLISHING.md](docs/PUBLISHING.md). Signing and the store listing are the owner's.
