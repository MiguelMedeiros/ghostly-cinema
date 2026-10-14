# Changes

What each published version of Cinema changed, newest first. A version is published when its signed bundle,
`app.ghostlyapp`, is committed here and the [Ghostly store](https://github.com/MiguelMedeiros/ghostly-store) lists it
([docs/PUBLISHING.md](docs/PUBLISHING.md)). `sequence` is the number Ghostly orders versions by.

## 0.1.1 (sequence 2)

- **An icon.** Cinema has its own icon (`icon.png` in the bundle, 512 x 512): the Ghostly ghost behind a bucket of
  popcorn, under a film strip, drawn by `scripts/icon.mjs`. Ghostly showed the generic app mark before.
- **Subtitles with `->`.** A subtitle file that writes `->` between a cue's times (Tears of Steel's own pt-BR
  subtitles do) showed no cue; now it shows them all.
- **The right `ffmpeg` line.** A file that needs converting gets a line that copies the video as it is and makes only
  the audio AAC (a MOV with MP3 sound plays in neither Chromium's nor WebKit's Media Source); a video the browser cannot
  decode is encoded again. The hint says what plays: MP4, M4V and MOV with H.264 video and AAC audio.
- A widescreen film (1280 x 534) is labelled 720p, not SD. The home banner shows the longest film with a picture.
- `npm run demo`: both sides of a chat on one page, to try Cinema by hand (not part of the bundle).

## 0.1.0 (sequence 1)

The first version.

- **Share a folder.** Pick the folder with your films and series: Cinema builds a library from the names (films with
  their years; shows, seasons and episodes, `S01E02`, `1x02` or a "Season 1" folder), with the subtitles and pictures
  beside them, and a frame of the video where there is no picture. Nothing is copied, uploaded or looked up online.
- **Watch a contact's library.** Rows of posters: Continue watching, Recently added, Films, Series; search; a film's
  details; a show's seasons and episodes.
- **Stream.** A film plays from the contact's device over the chat, MP4, M4V or MOV, starting anywhere: seeking asks
  for the part at the new time. Audio languages, subtitles (`.srt` in UTF-8 or Windows-1252, `.vtt`), resume where you
  stopped, Next episode.
- MKV, AVI and other containers show as needing conversion, with the lossless `ffmpeg` line.
- English and Brazilian Portuguese.
