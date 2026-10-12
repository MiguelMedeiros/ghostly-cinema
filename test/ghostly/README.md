# Cinema in real Ghostly

`apps-cinema.spec.ts` runs Cinema between two web clients of Ghostly, with Ghostly's own end-to-end harness: a local
relay pairs them, and Cinema is installed from a store the test signs with throwaway keys (the SHA-256 of a fixed
label, as Ghostly's apps specs do). It is not run by this repository's CI; it needs a checkout of Ghostly's `dev`:

```sh
npm run build                                          # here: dist/index.html
git clone --branch dev https://github.com/MiguelMedeiros/ghostly /tmp/ghostly-e2e
cd /tmp/ghostly-e2e && npm ci
cp ~/code/ghostly-cinema/test/ghostly/apps-cinema.spec.ts e2e/web/
CINEMA_DIR=~/code/ghostly-cinema npx playwright test -c e2e/playwright.config.ts --project web e2e/web/apps-cinema.spec.ts
```

The first run builds Ghostly's web app (`npm run build:web`, a few minutes). Nothing is committed to Ghostly.
