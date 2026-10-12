# Publishing a version of Cinema

A version of Cinema is published in three places, in this order:

1. **This repository** holds the signed bundle, `app.ghostlyapp`, at its root. The manifest's `sources` names it.
2. **The Ghostly store** ([ghostly-store](https://github.com/MiguelMedeiros/ghostly-store)) holds Cinema's
   `listing.json`: the version (`sequence` and `digest`) and the URLs clients fetch it from.
3. **The store's signed index** names that listing. A Cinema installed from the store updates only to the version the
   signed index lists (WISP 1200, Updates and rollback), so nothing reaches people before step 3.

Only the holder of the Cinema publisher key can sign a version: Ghostly refuses an update signed by another key. The
key is never in this repository, in a pull request, in CI or in a chat. Everything up to "Sign" can be done by anyone
and is checked by CI; "Sign" and the store's index are the owner's steps.

| | |
|---|---|
| Cinema's reference | `<publisher key>/cinema`, known once the first version is signed |
| Publisher key file (owner's machine only) | `~/ghostly-keys/cinema-publisher.key`, made by the first `ghostly app publish` |
| Store folder | `apps/cinema.<first 16 characters of the key>/` |
| Published so far | Nothing. See [CHANGES.md](../CHANGES.md) |

**The repository must be public** for the store to list it: clients fetch the bundle from jsDelivr pinned to a commit,
and from `raw.githubusercontent.com`, and neither serves a private repository. If this repository stays private, the
bundle goes in the store's own folder instead (as Chess's did until 1.0.2): `sources` and the listing's URLs then name
`https://raw.githubusercontent.com/MiguelMedeiros/ghostly-store/HEAD/apps/cinema.<prefix>/app.ghostlyapp` and its
jsDelivr copy at the store's commit.

## 1. Prepare the version (a pull request)

1. Raise `version` in `ghostly-app.json`, `package.json` and `package-lock.json` (`npm version <x.y.z>
   --no-git-tag-version` does the last two; `test/version.test.ts` fails when the three differ). Write `releaseNotes`
   in `ghostly-app.json`: one line, at most 500 characters, shown with the update.
2. Add the version to [CHANGES.md](../CHANGES.md).
3. Run everything:

   ```sh
   npm ci
   npm run typecheck
   npm test
   npx playwright install chromium webkit   # once
   npm run test:browser
   ```

4. Tick every item of the README's [Checked by hand](../README.md#checked-by-hand), with the client versions, in the
   pull request.
5. Merge it. The commit on `main` is the one that is built and signed.

## 2. Build and stage

On the commit to publish, with a clean tree:

```sh
git switch main && git pull && git status --short     # nothing listed
npm ci && npm test && npm run build
npm run digest                    # the page's size and SHA-256
npm run stage                     # release/index.html + release/ghostly-app.json
```

The build is reproducible: the same commit gives the same bytes on any machine, so the digest `npm run digest` prints
is the one CI printed for that commit (the "Typecheck, test, build" job's summary, and its `cinema-index-html`
artifact). If they differ, stop. `ghostly app publish` takes every file in the folder it is given, so it is run on
`release/`, never on the repository.

## 3. Sign (the owner)

The Ghostly CLI is built from a checkout of [Ghostly](https://github.com/MiguelMedeiros/ghostly)'s `dev` (the CLI on
npm has no `app` commands):

```sh
# Once, then `git -C ~/code/ghostly-cli pull` and the two npm commands again before a release.
git clone --branch dev https://github.com/MiguelMedeiros/ghostly ~/code/ghostly-cli
(cd ~/code/ghostly-cli && npm ci && npm run build -w @ghostlytools/cli)
ghostly() { node ~/code/ghostly-cli/packages/cli/dist/ghostly.mjs "$@"; }
```

**The first version** makes the key. Back it up: an app is updated only with the key that signed it, and there is no
recovery.

```sh
ghostly app publish release --key ~/ghostly-keys/cinema-publisher.key --out app.ghostlyapp --sequence 1 --pretty
chmod 600 ~/ghostly-keys/cinema-publisher.key
ghostly app verify app.ghostlyapp --pretty
npm run check:bundle
```

- `publish` says `"keyCreated": true` this once. Never again: on a later version it means the key file's path was
  wrong and a new key was made; delete that file and the bundle, and sign again with the right path.
- `ghostly app verify` says `"valid": true`, `"ref": "<key>/cinema"`, the version and `"sequence": 1`.
- `npm run check:bundle` says the bundle is this checkout's build and prints the line that pins the key: write
  `PUBLISHER = "<key>"` in `scripts/bundle.mjs` and the key in the table above, and commit them with the bundle. From
  then on `check:bundle` refuses a bundle signed by any other key, and `npm run check:bundle -- --expect <sequence>`
  prints a version's digest before it is signed.

**Later versions** leave `--sequence` out: `publish` reads the bundle at `--out`, raises its sequence by one, and refuses
when the key is not the one that signed it.

A sequence is never signed twice. If a signed bundle is wrong and was already pushed, publish the fix as the next
sequence.

## 4. Commit the bundle here

The bundle goes in a commit of its own, straight after the commit it was built from, so the store can pin that commit:

```sh
git add app.ghostlyapp scripts/bundle.mjs docs/PUBLISHING.md   # the last two the first time only
git commit -m "Cinema 0.1.0 (sequence 1)"
git push origin main
npm run check:bundle -- --listing     # prints the store's listing.json, pinned to that commit
```

`.gitignore` lets in `app.ghostlyapp` at the root only. Never commit `release/`, another bundle or a key. Once pushed:

```sh
ghostly app verify https://raw.githubusercontent.com/MiguelMedeiros/ghostly-cinema/HEAD/app.ghostlyapp
ghostly app verify https://cdn.jsdelivr.net/gh/MiguelMedeiros/ghostly-cinema@<the commit>/app.ghostlyapp
```

## 5. List it in the store, and sign the index (the owner)

In a clone of [ghostly-store](https://github.com/MiguelMedeiros/ghostly-store), on a branch:

1. Add `apps/cinema.<first 16 characters of the key>/listing.json` with what `npm run check:bundle -- --listing`
   printed (category `Video`, developer and submitter `Ghostly`). The jsDelivr URL is first and names the full commit.
2. Build and sign the index, in the same pull request:

   ```sh
   npm ci
   npm run build-index -- --out /tmp/ghostly-store.draft.json
   ghostly store sign /tmp/ghostly-store.draft.json --key ~/ghostly-keys/store.key --out .
   GHOSTLY=~/code/ghostly-cli scripts/check.sh        # "The store is valid."
   git add apps/cinema.<prefix> ghostly-store.json ghostly-store.sig
   git commit -m "Cinema 0.1.0 (sequence 1), published from ghostly-cinema"
   ```

3. Open the pull request. Its check fetches both URLs, verifies the bundle as a client does and compares its `sequence`
   and `digest` with the listing. Merge when it is green.

The store pins Ghostly at a commit that already reads `view` (`GHOSTLY_COMMIT`), so Cinema's `view: full` needs no
change there.

## What can go wrong

| What happens | Why, and what to do |
|---|---|
| `publish` says `unknown-key: view` | The CLI is older than `view`. Pull and build `~/code/ghostly-cli` again |
| `publish` says the key file may be read by others | `chmod 600 ~/ghostly-keys/cinema-publisher.key` |
| `publish` says `signed by another key` | The key is not Cinema's. Nothing was written |
| `check:bundle` says `is not this build's` | The tree changed between `npm run build` and `publish`, or `release/` was stale. Delete `app.ghostlyapp` (while nothing was pushed), then build, stage and sign again |
| The store's check says `answered 404` | The repository is private, or the bundle's commit is not on `main` yet |

## Revoking a version

`ghostly app revoke . --key ~/ghostly-keys/cinema-publisher.key --up-to <sequence>` (or `--digest <digest>`) writes
`ghostly-revoke.json` beside `app.ghostlyapp`. Commit it here, copy it to the store's folder for Cinema, and sign the
index. A leaked key cannot be replaced: Cinema would be published again under a new key, as a new app.
