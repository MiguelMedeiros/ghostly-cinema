/**
 * The broker answers at most 50 requests a second per app, every kind counted together, and stops an app that sends
 * far more. Every call Cinema makes goes through `paced`: at most `perSecond` in any second. A storage call refused
 * with `too-fast` anyway is tried again; `chat.send` is not, since the link decides what to send again.
 */
import type { MiniAppApi } from "./vendor/miniApp.ts";

export function paced(api: MiniAppApi, perSecond = 46, now = () => Date.now()): MiniAppApi {
  const times: number[] = [];
  let chain: Promise<void> = Promise.resolve();
  const slot = (): Promise<void> => {
    const next = chain.then(async () => {
      for (;;) {
        const t = now();
        while (times.length && times[0] <= t - 1000) times.shift();
        if (times.length < perSecond) {
          times.push(t);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, times[0] + 1000 - t + 1));
      }
    });
    chain = next.catch(() => {});
    return next;
  };
  const retried = async <T>(call: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      await slot();
      try {
        return await call();
      } catch (error) {
        if (attempt < 5 && error instanceof Error && error.message === "too-fast") {
          await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
          continue;
        }
        throw error;
      }
    }
  };
  return {
    context: () => retried(() => api.context()),
    file: (path) => retried(() => api.file(path)),
    storage: {
      get: (key) => retried(() => api.storage.get(key)),
      set: (key, value) => retried(() => api.storage.set(key, value)),
      delete: (key) => retried(() => api.storage.delete(key)),
      keys: () => retried(() => api.storage.keys()),
    },
    chat: {
      send: async (value) => {
        await slot();
        return api.chat.send(value);
      },
      on: api.chat.on.bind(api.chat) as MiniAppApi["chat"]["on"],
    },
    close: () => api.close(),
  };
}
