# Cinema's frames

Everything Cinema says to the same app on the contact's side travels as `apps/1` data frames (`ghostly.chat.send`):
JSON, at most 32 KiB each, live only. Either side may share a library and watch the other's. Every frame from the
contact is untrusted: fields are checked before use and an unknown frame is dropped.

## Hello

| Frame | When |
|---|---|
| `{t: "hello", v: 1, rev, name?}` | On start when the contact is open, and when the contact opens. `rev` is this side's library revision, 0 when it shares none; `name` its name in the chat (the `name` permission) |
| `{t: "hello", …, re: 1}` | The answer to a hello without `re`: a frame sent before the contact's app listened may be lost, so each side answers once |
| `{t: "lib", rev}` | This side's library changed (picked again, finished reading its files, stopped sharing: `rev` 0) |

A side that hears a `rev` other than the catalogue it kept asks for the catalogue.

## Transfers

The side that wants something asks; the other answers with bytes.

| Frame | From | Meaning |
|---|---|---|
| `{t: "get", r, k, id?, from?, at?, a?, s?}` | asker | Request `r` (a number of the asker's, from 1). `k`: `cat` the catalogue (JSON), `pic` a picture (JPEG) of a title or a show, `init` a film's init segment, `seg` a fragment from video sample `from` or from the keyframe before `at` seconds, `sub` subtitle `s`'s file. `a` is the audio track |
| `{t: "hdr", r, n, m?}` | answerer | `n` bytes follow; `m` what they are (below) |
| `{t: "dat", r, i, b, a?}` | answerer | Chunk `i`: base64 of bytes `i × 24000` to `(i + 1) × 24000`. `a: 1` asks for an ack now (the window is full, or it is the last chunk) |
| `{t: "ack", r, i}` | asker | Every chunk before `i` arrived. Sent every 2 chunks and when asked |
| `{t: "err", r, e}` | answerer | Refused: `no-library`, `not-found`, `not-picked` (the folder must be picked again), `convert`, `bad-request`, `too-large`, `damaged`, or what reading the file found (`no-moov`, `encrypted`, `unknown-codec`…) |
| `{t: "cancel", r}` | asker | Stop sending `r` (a seek) |

`m` for `init`: `{m: "video/mp4; codecs=…", d: seconds, au: [audio languages], n: video samples}`. For `seg`:
`{from, to, s, e, last}`: the video samples `[from, to)`, the seconds they cover, and whether it is the end.

**Flow.** One queue per side for every frame, at most 40 a second (the broker takes 48 `chat.send` and 50 requests of
any kind a second), control frames before chunks. A window of chunks unacknowledged, from 4, growing by one each second
the channel takes everything and halving when it refuses (`offline` or `too-fast` while the contact is still open: on
Iroh and HyperDHT in a browser a full channel answers `offline`); the refused frame is sent again. A transfer that hears
nothing for 15 s ends. A closed contact ends every transfer.

## The catalogue

`{v: 1, rev, items, shows}`, with no path: where files are on the sharer's disk stays there.

- A show: `{id, t, y?, p?}` (`p: 1` it has a picture).
- An item: `{id, k: "f" | "e", t, z, y?, sh?, sn?, ep?, ee?, d?, m?, au?, sb?, p?, x?, w?, h?, at?}`: film or episode,
  its title, bytes, year; an episode's show, season, number (and last number of a double episode); seconds; the Media
  Source type; audio languages; subtitles `[{id, l?, f?, h?}]` (language, forced, SDH); a picture; why it cannot play
  (`convert`, or what reading it found); pixels; when the file changed.

Ids are 53-bit hashes of paths in base 36, so picking the same folder again keeps them, and the contact's places in
films still hold.

## Storage (per app and per chat, 5 MiB)

| Key | Side | What |
|---|---|---|
| `mine`, `mine:<g>:<n>` | sharer | The library: paths, sizes, what reading each file found, revision. In pieces of 28 KB (`src/store.ts`) |
| `pic:<id>` | sharer | Its pictures, at most 2 MiB in all |
| `theirs`, `theirs:<g>:<n>` | watcher | The contact's catalogue |
| `tp:<id>` | watcher | The contact's pictures, at most 2 MiB, the oldest let go first |
| `pos:<id>` | watcher | `[seconds, length, when]` where a title was left |
| `prefs` | both | The subtitle and audio language chosen last |
