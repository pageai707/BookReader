// Builds the static site into dist/:
//   dist/                     ← site/ (the single-page app)
//   dist/pdfjs/               ← PDF.js viewer (same version as pdfjs-dist)
//   dist/library/…            ← the PDFs, in the same folders as library/
//   dist/thumbs/<sha>.webp    ← first-page thumbnails
//   dist/data/text/<sha>.json ← text of every page (fetched to show search snippets)
//   dist/data/index/<xx>.json ← full-text word index, sharded by the first two letters
//   dist/data/catalog.json    ← library title, folder tree, documents
//
// Metadata comes from library/**/meta.toml (see scripts/catalog.mjs), falling back to what's inside each PDF.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parse as parseToml } from "smol-toml";
import { shardOf, tokenize } from "../site/lib.js";
import {
  META_FILE, assignIds, docId, repoUrl, fileUrl, folderOf, parseAddedDates, pickTitle, slugify, splitAuthors, splitList, readMeta,
} from "./catalog.mjs";
import { CACHE, LIBRARY, PDFJS_DIR, ROOT, analyzePdf } from "./extract.mjs";

const run = promisify(execFile);

const SITE = path.join(ROOT, "site");
const DIST = path.resolve(process.env.BOOKREADER_DIST || path.join(ROOT, "dist"));
const WARN_MB = 50; // GitHub warns above 50 MB and rejects files above 100 MB

const PDFJS_VERSION = JSON.parse(await readFile(path.join(PDFJS_DIR, "package.json"), "utf8")).version;

const log = (...a) => console.log(...a);
const warnings = [];
const warn = (msg) => warnings.push(msg);

// ---------- PDF.js viewer ----------

async function ensureViewer() {
  const dir = path.join(CACHE, `pdfjs-viewer-${PDFJS_VERSION}`);
  if (existsSync(path.join(dir, "web", "viewer.html"))) return dir;

  const zip = path.join(CACHE, `pdfjs-${PDFJS_VERSION}-dist.zip`);
  if (!existsSync(zip)) {
    const url = `https://github.com/mozilla/pdf.js/releases/download/v${PDFJS_VERSION}/pdfjs-${PDFJS_VERSION}-dist.zip`;
    log(`Downloading PDF.js viewer ${PDFJS_VERSION}…`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not download ${url}: ${res.status}`);
    await mkdir(CACHE, { recursive: true });
    await writeFile(zip, Buffer.from(await res.arrayBuffer()));
  }
  await rm(dir, { recursive: true, force: true });
  await run("unzip", ["-q", "-o", zip, "-d", dir]);
  return dir;
}

// ---------- library scan ----------

// → { files: ["a/b.pdf", …], dirs: ["", "a", …] } (paths relative to library/, "/" separated)
async function scan(dir = LIBRARY, rel = "", out = { files: [], dirs: [] }) {
  if (!existsSync(dir)) return out;
  out.dirs.push(rel);
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await scan(path.join(dir, e.name), childRel, out);
    else if (/\.pdf$/i.test(e.name)) out.files.push(childRel);
  }
  return out;
}

async function readMetas(dirs) {
  const metas = new Map();
  for (const dir of dirs) {
    const rel = path.posix.join("library", dir, META_FILE);
    const file = path.join(LIBRARY, dir, META_FILE);
    if (!existsSync(file)) continue;
    let raw;
    try {
      raw = parseToml(await readFile(file, "utf8"));
    } catch (e) {
      throw new Error(`${rel} is not valid TOML:\n${e.message}`);
    }
    const meta = readMeta(raw, rel);
    meta.warnings.forEach(warn);
    metas.set(dir, meta);
  }
  return metas;
}

// Repository page for the header button: [library] repo in meta.toml, else GitHub Actions' env, else the git remote.
async function repository(libraryMeta) {
  if (libraryMeta.repo) return libraryMeta.repo;
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: name } = process.env;
  if (server && name) return `${server}/${name}`;
  try {
    const { stdout } = await run("git", ["remote", "get-url", "origin"], { cwd: ROOT });
    return repoUrl(stdout);
  } catch {
    return "";
  }
}

async function addedDates() {
  try {
    const { stdout } = await run(
      "git",
      ["log", "--no-renames", "--diff-filter=A", "--format=%x00%cI", "--name-only", "--", "library"],
      { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
    );
    return parseAddedDates(stdout, "library/");
  } catch {
    return new Map();
  }
}

// ---------- main ----------

async function main() {
  const started = Date.now();
  await rm(DIST, { recursive: true, force: true });
  for (const d of ["data/text", "data/index", "thumbs"]) await mkdir(path.join(DIST, d), { recursive: true });

  await cp(SITE, DIST, { recursive: true });
  const viewer = await ensureViewer();
  await cp(viewer, path.join(DIST, "pdfjs"), {
    recursive: true,
    filter: (src) => !src.endsWith(".map") && !src.endsWith("compressed.tracemonkey-pldi-09.pdf"),
  });

  const { files, dirs } = await scan();
  const metas = await readMetas(dirs);
  const legacyIds = assignIds(files);
  const added = await addedDates();
  log(`Indexing ${files.length} PDF${files.length === 1 ? "" : "s"} from library/`);

  // meta.toml entries that don't match a file (usually a renamed or moved PDF)
  const fileSet = new Set(files);
  for (const [dir, meta] of metas) {
    for (const name of meta.pdfs.keys()) {
      if (!fileSet.has(dir ? `${dir}/${name}` : name)) {
        warn(`library/${dir ? `${dir}/` : ""}${META_FILE}: [pdf."${name}"] has no matching PDF in that folder`);
      }
    }
  }

  // Folder tree: every folder that holds documents (directly or below), with titles from meta.toml.
  const folderInfo = (dir) => {
    const m = metas.get(dir)?.folder || {};
    return { path: dir, name: dir.split("/").pop(), title: m.title || dir.split("/").pop(), description: m.description || "", order: m.order };
  };
  const usedFolders = new Set();
  for (const f of files) {
    const parts = folderOf(f).split("/").filter(Boolean);
    parts.forEach((_, i) => usedFolders.add(parts.slice(0, i + 1).join("/")));
  }
  const folders = [...usedFolders].sort().map(folderInfo);
  const folderTitle = (dir) =>
    dir
      .split("/")
      .filter(Boolean)
      .map((_, i, parts) => folderInfo(parts.slice(0, i + 1).join("/")).title)
      .join(" › ");

  const docs = [];
  const terms = new Map(); // doc id → Map(term → count)
  const seen = new Map(); // sha → path, to skip duplicates
  for (const rel of files.sort()) {
    const { sha, size, x, cacheThumb } = await analyzePdf(path.join(LIBRARY, rel), { log });
    if (seen.has(sha)) {
      warn(`library/${rel} is identical to library/${seen.get(sha)}; skipped`);
      continue;
    }
    seen.set(sha, rel);
    if (size > WARN_MB * 1024 * 1024) warn(`library/${rel} is ${(size / 1048576).toFixed(0)} MB; GitHub rejects files over 100 MB`);

    const folder = folderOf(rel);
    const filename = rel.split("/").pop();
    const meta = metas.get(folder)?.pdfs.get(filename) || {};
    const info = x.ok ? x.info : {};
    const id = docId(sha);

    await mkdir(path.join(DIST, "library", folder), { recursive: true });
    await cp(path.join(LIBRARY, rel), path.join(DIST, "library", rel));

    let thumb = null;
    if (x.ok && x.thumb && existsSync(cacheThumb)) {
      await cp(cacheThumb, path.join(DIST, "thumbs", `${sha}.webp`));
      thumb = `thumbs/${sha}.webp`;
    }
    let text = null;
    if (x.ok && x.pages.some((p) => p)) {
      await writeFile(path.join(DIST, "data", "text", `${sha}.json`), JSON.stringify(x.pages));
      text = `data/text/${sha}.json`;
      const counts = new Map();
      for (const page of x.pages) for (const t of tokenize(page)) counts.set(t, (counts.get(t) || 0) + 1);
      terms.set(id, counts);
    }

    const title = pickTitle({ meta, infoTitle: info.title, textTitle: x.textTitle, filename });
    const legacy = legacyIds.get(rel);
    docs.push({
      id,
      slug: slugify(title, 60),
      title,
      authors: meta.authors || splitAuthors(info.author),
      year: meta.year || (info.created ? Number(info.created.slice(0, 4)) : null),
      publisher: meta.publisher || "",
      description: meta.description || String(info.subject || "").trim(),
      tags: meta.tags || splitList(info.keywords).map((t) => t.toLowerCase()).slice(0, 20),
      url: meta.url || "",
      folder,
      folderTitle: folderTitle(folder),
      path: rel,
      file: fileUrl("library", rel),
      filename,
      size,
      pages: x.ok ? x.numPages : null,
      added: added.get(rel) || (await stat(path.join(LIBRARY, rel))).mtime.toISOString(),
      thumb,
      text,
      legacy: legacy !== id ? legacy : undefined,
      error: x.ok ? undefined : x.error,
    });
  }

  docs.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));

  // Full-text index: term → [docNumber, count, …], where docNumber is the position in catalog.docs.
  const shards = new Map();
  docs.forEach((doc, n) => {
    for (const [term, count] of terms.get(doc.id) || []) {
      const name = shardOf(term);
      let shard = shards.get(name);
      if (!shard) shards.set(name, (shard = new Map()));
      let post = shard.get(term);
      if (!post) shard.set(term, (post = []));
      post.push(n, Math.min(count, 9999));
    }
  });
  let indexBytes = 0;
  for (const [name, shard] of shards) {
    const json = JSON.stringify(Object.fromEntries(shard));
    indexBytes += json.length;
    await writeFile(path.join(DIST, "data", "index", `${name}.json`), json);
  }

  const libraryMeta = metas.get("")?.library || {};
  const catalog = {
    generated: new Date().toISOString(),
    pdfjs: PDFJS_VERSION,
    library: { title: libraryMeta.title || "BookReader", description: libraryMeta.description || "", repo: await repository(libraryMeta) },
    root: folderInfo(""),
    folders,
    shards: [...shards.keys()].sort(),
    docs,
  };
  await writeFile(path.join(DIST, "data", "catalog.json"), JSON.stringify(catalog));

  for (const w of warnings) console.warn(`  ! ${w}`);
  log(
    `Built dist/ with ${docs.length} document${docs.length === 1 ? "" : "s"} in ${folders.length} folder${folders.length === 1 ? "" : "s"}` +
      ` (index ${(indexBytes / 1024).toFixed(0)} KB in ${shards.size} shards) in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
}

main().catch((e) => {
  console.error(`\nBuild failed: ${e.message.includes("is not valid TOML") ? e.message : e.stack}`);
  process.exit(1);
});
