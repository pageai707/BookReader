// Copy PDFs from anywhere on your computer into library/, then add a pre-filled entry for each one
// to that folder's meta.toml (see scripts/sync.mjs) so you only need to review the details.
//
//   npm run add -- ~/Downloads/paper.pdf ~/Books                  # files and/or folders (searched recursively)
//   npm run add -- ~/Books --to "Machine Learning/NLP"            # into library/Machine Learning/NLP/
//   npm run add -- ~/Books --keep-folders                         # keep the source sub-folders as categories
//
// Skips PDFs already in the library (same content), and never overwrites a different file with the same name.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncMeta } from "./sync.mjs";

const LIBRARY = fileURLToPath(new URL("../library", import.meta.url));
const MB = 1024 * 1024;

const args = process.argv.slice(2);
let to = "";
let keepFolders = false;
const inputs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--to") to = args[++i] ?? "";
  else if (args[i] === "--keep-folders") keepFolders = true;
  else inputs.push(args[i]);
}
if (!inputs.length) {
  console.log('Usage: npm run add -- <pdf-or-folder>... [--to "Collection"] [--keep-folders]');
  process.exit(1);
}

const cleanName = (s) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/\s+/g, " ").trim();
const sha = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");

async function findPdfs(p, base) {
  const s = await stat(p);
  if (s.isFile()) return /\.pdf$/i.test(p) ? [{ file: p, sub: "" }] : [];
  const out = [];
  for (const e of await readdir(p, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(p, e.name);
    if (e.isDirectory()) out.push(...(await findPdfs(full, base)));
    else if (/\.pdf$/i.test(e.name)) out.push({ file: full, sub: path.relative(base, p) });
  }
  return out;
}

async function libraryHashes(dir = LIBRARY, out = new Map()) {
  if (!existsSync(dir)) return out;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await libraryHashes(full, out);
    else if (/\.pdf$/i.test(e.name)) out.set(await sha(full), path.relative(LIBRARY, full));
  }
  return out;
}

const known = await libraryHashes();
let added = 0;
let skipped = 0;
for (const input of inputs) {
  const abs = path.resolve(input.replace(/^~(?=$|\/)/, process.env.HOME));
  if (!existsSync(abs)) {
    console.warn(`! not found: ${input}`);
    continue;
  }
  const base = (await stat(abs)).isDirectory() ? abs : path.dirname(abs);
  for (const { file, sub } of await findPdfs(abs, base)) {
    const size = (await stat(file)).size;
    if (size > 100 * MB) {
      console.warn(`! skipped ${file}: ${(size / MB).toFixed(0)} MB is over GitHub's 100 MB file limit`);
      skipped++;
      continue;
    }
    const hash = await sha(file);
    if (known.has(hash)) {
      console.log(`= already in library: ${known.get(hash)}`);
      skipped++;
      continue;
    }
    const folder = [to, keepFolders ? sub : ""].filter(Boolean).map((s) => s.split(path.sep).map(cleanName).join("/")).join("/");
    const destDir = path.join(LIBRARY, folder);
    await mkdir(destDir, { recursive: true });
    const stem = cleanName(path.basename(file).replace(/\.pdf$/i, "")) || "document";
    let dest = path.join(destDir, `${stem}.pdf`);
    for (let n = 2; existsSync(dest); n++) dest = path.join(destDir, `${stem} (${n}).pdf`);
    await copyFile(file, dest);
    known.set(hash, path.relative(LIBRARY, dest));
    console.log(`+ library/${path.relative(LIBRARY, dest)}${size > 50 * MB ? "  (large: over 50 MB)" : ""}`);
    added++;
  }
}
console.log(`\n${added} added, ${skipped} skipped.`);
if (added) {
  console.log("\nUpdating meta.toml…");
  await syncMeta();
  console.log("\nNext: check the titles/authors in meta.toml, preview with `npm run dev`, then commit and push.");
}
