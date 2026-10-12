// What a path says: films with their years, episodes with their show, season and number, subtitles and pictures.
import { describe, expect, it } from "vitest";
import { cleanTitle, parseSubtitleName, parseVideoPath, showKey } from "../src/names.ts";

describe("films", () => {
  it.each([
    ["Inception.2010.1080p.BluRay.x264-SPARKS.mp4", "Inception", 2010],
    ["Films/Inception (2010)/Inception.mp4", "Inception", 2010],
    ["The.Matrix.1999.REMASTERED.720p.mkv", "The Matrix", 1999],
    ["2001 A Space Odyssey (1968).mp4", "2001 A Space Odyssey", 1968],
    ["Blade Runner 2049 (2017) [1080p].mp4", "Blade Runner 2049", 2017],
    ["Filmes/Cidade de Deus (2002)/movie.mp4", "Cidade de Deus", 2002],
    ["central_do_brasil_1998_dublado.mp4", "Central Do Brasil", 1998],
    ["Amélie.mp4", "Amélie", undefined],
    ["Movies/Up/VTS_01_1.mp4", "Up", undefined],
    ["Mr. Robot is not an episode.mp4", "Mr. Robot is not an episode", undefined],
    ["1917.mp4", "1917", undefined],
  ])("%s", (path, title, year) => {
    const parsed = parseVideoPath(path);
    expect(parsed.kind).toBe("film");
    expect(parsed.title).toBe(title);
    expect(parsed.year).toBe(year);
  });
});

describe("episodes", () => {
  it.each([
    ["Series/The Office/Season 2/The.Office.S02E03.Office.Olympics.720p.mp4", "The Office", 2, 3, "Office Olympics"],
    ["Breaking.Bad.S05E14.Ozymandias.1080p.WEB-DL.mp4", "Breaking Bad", 5, 14, "Ozymandias"],
    ["Dark/Temporada 1/01.mp4", "Dark", 1, 1, undefined],
    ["Dark (2017)/Season 3/Dark - Ep 08 - Light.mp4", "Dark", 3, 8, "Light"],
    ["friends.1x05.mp4", "Friends", 1, 5, undefined],
    ["Sherlock/Sherlock Season 2 Episode 1.mp4", "Sherlock", 2, 1, undefined],
    ["Séries/Chaves/Chaves S01E01.mp4", "Chaves", 1, 1, undefined],
    ["The Wire/S01/s01e01.mp4", "The Wire", 1, 1, undefined],
    ["Doctor Who/Specials/Doctor Who - 05.mp4", "Doctor Who", 0, 5, undefined],
  ])("%s", (path, show, season, episode, episodeTitle) => {
    const parsed = parseVideoPath(path);
    expect(parsed.kind).toBe("episode");
    expect(parsed.show).toBe(show);
    expect(parsed.season).toBe(season);
    expect(parsed.episode).toBe(episode);
    expect(parsed.episodeTitle).toBe(episodeTitle);
  });

  it("knows a file holding two episodes", () => {
    expect(parseVideoPath("Lost.S01E01E02.Pilot.mp4")).toMatchObject({ show: "Lost", season: 1, episode: 1, episodeEnd: 2, episodeTitle: "Pilot" });
    expect(parseVideoPath("Lost.S01E01-E02.mp4")).toMatchObject({ episode: 1, episodeEnd: 2 });
  });

  it("keeps a year in the show's name apart", () => {
    expect(parseVideoPath("Doctor.Who.2005.S01E01.Rose.mp4")).toMatchObject({ show: "Doctor Who", showYear: 2005, title: "Rose" });
  });

  it("groups the same show written two ways", () => {
    expect(showKey("The.Office")).toBe(showKey("The Office (2005)"));
    expect(showKey("Amélie")).toBe(showKey("Amelie"));
    expect(showKey("Law & Order")).toBe(showKey("Law and Order"));
  });
});

describe("subtitles", () => {
  it.each([
    ["Inception.2010.srt", "Inception.2010", undefined, false],
    ["Inception.2010.pt-BR.srt", "Inception.2010", "pt-BR", false],
    ["Inception.2010.por.forced.srt", "Inception.2010", "pt", true],
    ["The.Office.S02E03.en.sdh.vtt", "The.Office.S02E03", "en", false],
    ["Dark.S01E01.English.srt", "Dark.S01E01", "en", false],
    ["Film.2026.pt-BR.srt", "Film.2026", "pt-BR", false],
  ])("%s", (file, base, lang, forced) => {
    const parsed = parseSubtitleName(file);
    expect(parsed.base).toBe(base);
    expect(parsed.lang).toBe(lang);
    expect(parsed.forced).toBe(forced);
  });
});

describe("clean titles", () => {
  it("reads scene names and leaves written ones alone", () => {
    expect(cleanTitle("the.big.lebowski")).toBe("The Big Lebowski");
    expect(cleanTitle("Mr. Robot")).toBe("Mr. Robot");
    expect(cleanTitle("[Group] Spirited_Away")).toBe("Spirited Away");
    expect(cleanTitle("  - Title -  ")).toBe("Title");
  });
});
