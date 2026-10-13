# Changes

What each published version of Cinema changed, newest first. A version is published when its signed bundle,
`app.ghostlyapp`, is committed here and the [Ghostly store](https://github.com/MiguelMedeiros/ghostly-store) lists it
([docs/PUBLISHING.md](docs/PUBLISHING.md)). `sequence` is the number Ghostly orders versions by.

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
