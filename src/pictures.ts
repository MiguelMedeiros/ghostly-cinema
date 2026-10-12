/**
 * The small JPEGs the library shows, made on the sharing side: a poster beside a film made small, or a frame from a
 * little way into the video. Made in the page with a canvas; a `blob:` URL plays a picked file in the sandbox on
 * every engine (measured), unlike a Media Source one.
 */
import type { PictureMaker } from "./share.ts";

/** Posters fit in this box; frames are this wide. */
const POSTER = { w: 240, h: 360 };
const FRAME_W = 360;
/** The most a picture may weigh. */
const MAX_BYTES = 40 * 1024;
const TIMEOUT_MS = 8000;

function canvasBytes(canvas: HTMLCanvasElement, quality: number): Promise<Uint8Array | null> {
  return new Promise((resolve) =>
    canvas.toBlob(
      (blob) => {
        if (!blob) return resolve(null);
        blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), () => resolve(null));
      },
      "image/jpeg",
      quality,
    ),
  );
}

async function encode(source: CanvasImageSource, width: number, height: number, box: { w: number; h: number }): Promise<Uint8Array | null> {
  if (!width || !height) return null;
  let scale = Math.min(box.w / width, box.h / height, 1);
  for (let attempt = 0; attempt < 4; attempt++) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.78, 0.62]) {
      const bytes = await canvasBytes(canvas, quality);
      if (bytes && bytes.length <= MAX_BYTES) return bytes;
    }
    scale *= 0.75;
  }
  return null;
}

const timeout = <T>(p: Promise<T>, ms = TIMEOUT_MS) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);

/** Plays until the next frame is on screen. */
async function shownFrame(video: HTMLVideoElement): Promise<void> {
  const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
  const shown = new Promise<void>((resolve) => {
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => resolve());
    else video.addEventListener("timeupdate", () => resolve(), { once: true });
  });
  await video.play();
  await shown;
}

export const pagePictures: PictureMaker = {
  async fromImage(file) {
    const bitmap = await timeout(createImageBitmap(file));
    try {
      return await encode(bitmap, bitmap.width, bitmap.height, POSTER);
    } finally {
      bitmap.close();
    }
  },

  async fromVideo(file) {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    try {
      const loaded = new Promise<void>((resolve, reject) => {
        video.addEventListener("loadedmetadata", () => resolve(), { once: true });
        video.addEventListener("error", () => reject(new Error("decode")), { once: true });
      });
      video.src = url;
      await timeout(loaded);
      const d = Number.isFinite(video.duration) ? video.duration : 0;
      const at = Math.min(Math.max(d * 0.1, Math.min(1, d / 2)), 300);
      const seeked = new Promise<void>((resolve) => video.addEventListener("seeked", () => resolve(), { once: true }));
      video.currentTime = at;
      await timeout(seeked);
      if (video.readyState < 2) await timeout(new Promise<void>((resolve) => video.addEventListener("loadeddata", () => resolve(), { once: true })));
      // WebKit draws a seeked video that never played as black: let it show one frame, muted, first.
      await timeout(shownFrame(video), 3000).catch(() => {});
      video.pause();
      return await encode(video, video.videoWidth, video.videoHeight, { w: FRAME_W, h: FRAME_W });
    } finally {
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    }
  },
};
