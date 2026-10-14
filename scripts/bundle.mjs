// What the signed bundle holds, and whether it is this checkout's build: run it after `ghostly app publish`, before
// the bundle is committed. See docs/PUBLISHING.md.
//
//   npm run build && npm run check:bundle                 app.ghostlyapp at the repository root
//   npm run check:bundle -- --listing                     also prints the store's listing.json for it
//   npm run check:bundle -- <file>                        another bundle
//   npm run check:bundle -- --expect <sequence>           no bundle needed: the digest this build will have, signed
//                                                         by the Cinema key under that sequence
//
// It reads the bundle's manifest (WISP 1200: "GHOSTLYAPP1", the manifest's length, the manifest) and checks that it
// is Cinema under the Cinema publisher key, that it says what ghostly-app.json says, and that its files are
// assets/icon.png (as icon.png) and dist/index.html, byte for byte. It does NOT check the signature: `ghostly app
// verify` does that, and the store's check does it again.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Cinema publisher key (public): only it signs a version of Cinema that an installed Cinema takes. Empty until
 * the owner signs the first version (`ghostly app publish` makes the key then): write the key it prints here, in the
 * same commit as the first bundle (docs/PUBLISHING.md). While it is empty, any key passes and the script says so.
 */
export const PUBLISHER = "oanmb35oi8qosn6m5zwuraq1odwgepopohuxzmq19jd513p55hgo";
export const REPO = "MiguelMedeiros/ghostly-cinema";
export const BUNDLE = "app.ghostlyapp";
/** Where clients read newer bundles: this repository's HEAD. The manifest's `sources` names it. */
export const SOURCE = `https://raw.githubusercontent.com/${REPO}/HEAD/${BUNDLE}`;
/** The fields `ghostly app publish` writes into the manifest. */
const WRITTEN = ["ghostlyApp", "publisher", "sequence", "files"];
const MAGIC = Buffer.from("GHOSTLYAPP1");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("base64url");
/** JSON with every object's keys in order, to compare two values whatever order their keys were written in. */
const stable = (value) =>
  JSON.stringify(value, (_, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));

/** A bundle's manifest and its digest (SHA-256 of the manifest's bytes, base64url: what a listing names). */
export function readManifest(bytes) {
  const buffer = Buffer.from(bytes);
  if (buffer.length < MAGIC.length + 4 || !buffer.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("not a .ghostlyapp bundle");
  const length = buffer.readUInt32BE(MAGIC.length);
  const manifestBytes = buffer.subarray(MAGIC.length + 4, MAGIC.length + 4 + length);
  if (manifestBytes.length !== length) throw new Error("the bundle is cut short");
  return { manifest: JSON.parse(manifestBytes.toString("utf8")), digest: sha256(manifestBytes) };
}

/**
 * A manifest's digest, from its fields: the SHA-256 of its canonical JSON (RFC 8785: keys in order, no spaces), which
 * is the bytes `ghostly app publish` signs.
 */
export const digestOf = (manifest) => sha256(Buffer.from(stable(manifest)));

/** The icon, drawn by scripts/icon.mjs and committed. */
export const ICON = fileURLToPath(new URL("../assets/icon.png", import.meta.url));
const readIcon = () => readFileSync(ICON);

/** The bundle's files as its manifest lists them: sorted by path, so icon.png before index.html. */
export function filesOf(page, icon = readIcon()) {
  return [
    { path: "icon.png", size: icon.length, sha256: sha256(icon) },
    { path: "index.html", size: page.length, sha256: sha256(page) },
  ];
}

/** The manifest `ghostly app publish` makes of ghostly-app.json, the built page and the icon, under a key and a sequence. */
export function expected(source, page, sequence, publisher = PUBLISHER, icon = readIcon()) {
  return { ...source, ghostlyApp: 1, publisher, sequence, files: filesOf(page, icon) };
}

/** What is wrong with a bundle's manifest, given ghostly-app.json, the built page and the icon. Empty when nothing is. */
export function problems(manifest, source, page, icon = readIcon()) {
  const found = [];
  if (PUBLISHER && manifest.publisher !== PUBLISHER) found.push(`signed for another publisher key (${manifest.publisher}), not the Cinema key`);
  if (!Number.isSafeInteger(manifest.sequence) || manifest.sequence < 1) found.push(`sequence is ${JSON.stringify(manifest.sequence)}`);
  for (const key of new Set([...Object.keys(source), ...Object.keys(manifest)])) {
    if (WRITTEN.includes(key)) continue;
    if (stable(manifest[key]) !== stable(source[key])) found.push(`${key} is ${JSON.stringify(manifest[key])}, and ghostly-app.json says ${JSON.stringify(source[key])}`);
  }
  if (!(source.sources ?? []).includes(SOURCE)) found.push(`ghostly-app.json's sources does not name ${SOURCE}`);
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const want = filesOf(page, icon);
  if (files.length !== want.length || files.some((f, i) => f.path !== want[i].path)) found.push(`holds ${files.map((f) => f.path).join(", ") || "no file"}, not icon.png and index.html`);
  else for (const [i, f] of files.entries()) if (f.sha256 !== want[i].sha256 || f.size !== want[i].size) found.push(`its ${f.path} (${f.size} bytes, ${f.sha256}) is not this build's (${want[i].size} bytes, ${want[i].sha256})`);
  return found;
}

/** The store's listing.json for a bundle committed here at `commit`: the copy pinned to that commit first, then HEAD. */
export function listing(manifest, digest, commit) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`${JSON.stringify(commit)} is not a full commit`);
  return {
    ref: `${manifest.publisher}/${manifest.name}`,
    sequence: manifest.sequence,
    digest,
    urls: [`https://cdn.jsdelivr.net/gh/${REPO}@${commit}/${BUNDLE}`, SOURCE],
    title: manifest.title,
    tagline: manifest.tagline,
    category: "Video",
    developer: "Ghostly",
    submitter: "Ghostly",
    repo: `https://github.com/${REPO}`,
    support: `https://github.com/${REPO}/issues`,
  };
}

function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const args = process.argv.slice(2);
  const wantListing = args.includes("--listing");
  const fail = (message) => {
    console.error(message);
    process.exit(1);
  };
  const dist = resolve(root, "dist/index.html");
  if (!existsSync(dist)) fail("no dist/index.html: run npm run build first");
  const source = JSON.parse(readFileSync(resolve(root, "ghostly-app.json"), "utf8"));
  const expect = args.indexOf("--expect");
  if (expect >= 0) {
    const sequence = Number(args[expect + 1]);
    if (!Number.isSafeInteger(sequence) || sequence < 1) fail("--expect takes the sequence the bundle will be signed under");
    if (!PUBLISHER) fail("the Cinema publisher key is not pinned yet (scripts/bundle.mjs): the first version's digest is known once it is signed");
    console.log(`Cinema ${source.version} of this build, signed by the Cinema key as sequence ${sequence}, has digest ${digestOf(expected(source, readFileSync(dist), sequence))}`);
    return;
  }
  const file = resolve(args.find((a) => !a.startsWith("--")) ?? resolve(root, BUNDLE));
  if (!existsSync(file)) fail(`no ${file}: sign the staged folder first (docs/PUBLISHING.md)`);
  const { manifest, digest } = readManifest(readFileSync(file));
  const found = problems(manifest, source, readFileSync(dist));
  console.log(`${file}: ${manifest.name} ${manifest.version}, sequence ${manifest.sequence}, digest ${digest}`);
  if (found.length) fail(found.map((p) => `problem: ${p}`).join("\n"));
  if (!PUBLISHER) console.log(`the publisher key is not pinned yet: write PUBLISHER = "${manifest.publisher}" in scripts/bundle.mjs, in this commit`);
  console.log("it is this checkout's build (the signature is for ghostly app verify to check)");
  if (!wantListing) return;
  if (file !== resolve(root, BUNDLE)) fail(`--listing is for ${BUNDLE} at the repository root`);
  const git = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();
  if (git("status", "--porcelain", "--", BUNDLE)) fail(`${BUNDLE} is not committed as it is: commit it first, the listing pins its commit`);
  const commit = git("log", "-1", "--format=%H", "--", BUNDLE);
  if (!commit) fail(`${BUNDLE} is not committed: commit it first, the listing pins its commit`);
  console.log(`\nlisting.json (the commit must be pushed to ${REPO}'s main before the store's check reads it):\n`);
  console.log(JSON.stringify(listing(manifest, digest, commit), null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
