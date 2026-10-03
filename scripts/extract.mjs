// Reads a PDF once (metadata, text of every page, first-page thumbnail) and caches the result
// in .cache/docs/<sha>.{json,webp}, keyed by content hash. Shared by build, add and sync.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pageText, parsePdfDate, pickTitle, splitAuthors, titleFromText } from "./catalog.mjs";

const require = createRequire(import.meta.url);

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const LIBRARY = path.resolve(process.env.BOOKREADER_LIBRARY || path.join(ROOT, "library")); // override for testing
export const CACHE = path.join(ROOT, ".cache");
export const PDFJS_DIR = path.dirname(require.resolve("pdfjs-dist/package.json"));

const CACHE_VERSION = 2; // bump when extraction output changes
const THUMB_WIDTH = 360;
const TITLE_PAGES = 3; // look this far for a title when page 1 is a cover image

let pdfjs;
let createCanvas;

async function extract(bytes, thumbPath) {
  pdfjs ??= await import(pathToFileURL(path.join(PDFJS_DIR, "legacy/build/pdf.mjs")).href);
  if (createCanvas === undefined) {
    try {
      createCanvas = require("@napi-rs/canvas").createCanvas;
    } catch {
      createCanvas = null; // thumbnails are skipped, everything else still works
    }
  }

  const task = pdfjs.getDocument({
    data: bytes,
    standardFontDataUrl: path.join(PDFJS_DIR, "standard_fonts") + "/",
    cMapUrl: path.join(PDFJS_DIR, "cmaps") + "/",
    wasmUrl: path.join(PDFJS_DIR, "wasm") + "/",
    isEvalSupported: false,
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    const { info = {} } = await doc.getMetadata().catch(() => ({}));
    const pages = [];
    let textTitle = "";
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const { items } = await page.getTextContent();
      if (!textTitle && n <= TITLE_PAGES) textTitle = titleFromText(items);
      pages.push(pageText(items));
      if (n === 1 && createCanvas) {
        try {
          const vp = page.getViewport({ scale: THUMB_WIDTH / page.getViewport({ scale: 1 }).width });
          const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
          await page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
          await writeFile(thumbPath, await canvas.encode("webp", 78));
        } catch (e) {
          console.warn(`  ! thumbnail failed: ${e.message}`);
        }
      }
      page.cleanup();
    }
    return {
      ok: true,
      numPages: doc.numPages,
      info: {
        title: info.Title || "",
        author: info.Author || "",
        subject: info.Subject || "",
        keywords: info.Keywords || "",
        created: parsePdfDate(info.CreationDate),
      },
      textTitle,
      pages,
      thumb: existsSync(thumbPath),
    };
  } catch (e) {
    return { ok: false, error: e.name === "PasswordException" ? "password-protected" : e.message };
  } finally {
    await task.destroy();
  }
}

// → { sha, size, x (extraction result), cacheThumb }
export async function analyzePdf(fullPath, { log = () => {} } = {}) {
  const bytes = await readFile(fullPath);
  const sha = createHash("sha256").update(bytes).digest("hex").slice(0, 20);
  const cacheDir = path.join(CACHE, "docs");
  const cacheJson = path.join(cacheDir, `${sha}.json`);
  const cacheThumb = path.join(cacheDir, `${sha}.webp`);

  let x = null;
  if (existsSync(cacheJson)) {
    x = JSON.parse(await readFile(cacheJson, "utf8"));
    if (x.v !== CACHE_VERSION) x = null;
  }
  if (!x) {
    log(`  + reading ${path.relative(LIBRARY, fullPath)}`);
    await mkdir(cacheDir, { recursive: true });
    x = { v: CACHE_VERSION, ...(await extract(new Uint8Array(bytes), cacheThumb)) };
    if (!x.ok) console.warn(`  ! ${path.relative(LIBRARY, fullPath)}: ${x.error} (listed without text or thumbnail)`);
    await writeFile(cacheJson, JSON.stringify(x));
  }
  return { sha, size: bytes.length, x, cacheThumb };
}

// Best guesses used to pre-fill a new meta.toml entry.
export function guessMetadata(x, filename) {
  const info = x.ok ? x.info : {};
  return {
    title: pickTitle({ infoTitle: info.title, textTitle: x.textTitle, filename }),
    authors: splitAuthors(info.author),
    year: info.created ? Number(info.created.slice(0, 4)) : undefined,
  };
}
