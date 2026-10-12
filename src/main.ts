/**
 * Cinema, a Ghostly mini-app. The runner gives it `window.ghostly` (the broker, see src/vendor/miniApp.ts); opened
 * outside the runner in a dev server, it runs alone on a stand-in broker that keeps nothing.
 */
import { Cinema } from "./app.ts";
import { paced } from "./broker.ts";
import { pagePictures } from "./pictures.ts";
import { stringsFor } from "./strings.ts";
import { mountCinema } from "./ui.ts";
import type { MiniAppApi } from "./vendor/miniApp.ts";
import "./style.css";

/** A broker that keeps nothing, for `vite` in a browser tab. */
function standIn(): MiniAppApi {
  const store = new Map<string, unknown>();
  return {
    context: async () => ({ version: "dev", inChat: false, peer: null }),
    file: async () => new ArrayBuffer(0),
    storage: {
      get: async (key) => store.get(key) as never,
      set: async (key, value) => void store.set(key, value),
      delete: async (key) => void store.delete(key),
      keys: async () => [...store.keys()],
    },
    chat: { send: async () => Promise.reject(new Error("not-allowed")), on: () => () => {} },
    close: async () => {},
  };
}

async function main(): Promise<void> {
  const root = document.getElementById("app")!;
  const api = paced((window as { ghostly?: MiniAppApi }).ghostly ?? standIn());
  // Made before anything is awaited: it listens to the chat from the start.
  const app = new Cinema(api, pagePictures);
  const context = await api.context();
  const { strings, lang } = stringsFor(context.locale ?? navigator.language);
  document.documentElement.lang = lang;
  document.title = strings.title;
  try {
    await app.start();
  } catch (error) {
    root.textContent = String(error instanceof Error ? error.message : error);
    return;
  }
  mountCinema(root, app, api, strings, lang, context.inChat);
  addEventListener("pagehide", () => app.close());
}

void main();
