// Keeps library/**/meta.toml in step with the PDFs on disk:
//   • creates meta.toml in folders that don't have one
//   • appends a pre-filled [pdf."…"] entry for every PDF that has none (title/authors guessed from the PDF)
//   • reports entries whose PDF no longer exists (renamed or moved) — it never deletes or rewrites your text
//
//   npm run sync               # update meta.toml files
//   npm run sync -- --check    # only report; exit 1 if anything is missing (useful in CI)

import { existsSync } from "node:fs";
import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { META_FILE, folderStub, pdfStub, readMeta } from "./catalog.mjs";
import { LIBRARY, analyzePdf, guessMetadata } from "./extract.mjs";

async function folders(dir = LIBRARY, rel = "", out = []) {
  const entries = (await readdir(dir, { withFileTypes: true })).filter((e) => !e.name.startsWith("."));
  out.push({ rel, pdfs: entries.filter((e) => e.isFile() && /\.pdf$/i.test(e.name)).map((e) => e.name).sort() });
  for (const e of entries) if (e.isDirectory()) await folders(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, out);
  return out;
}

export async function syncMeta({ check = false, log = console.log } = {}) {
  const summary = { created: 0, added: 0, orphans: 0, errors: 0 };
  if (!existsSync(LIBRARY)) return summary;

  for (const { rel, pdfs } of await folders()) {
    const file = path.join(LIBRARY, rel, META_FILE);
    const shown = path.posix.join("library", rel, META_FILE);
    let known = new Set();
    let exists = existsSync(file);
    if (exists) {
      try {
        known = new Set(readMeta(parseToml(await readFile(file, "utf8")), shown).pdfs.keys());
      } catch (e) {
        log(`! ${shown} is not valid TOML, skipped:\n  ${e.message.split("\n")[0]}`);
        summary.errors++;
        continue;
      }
    }

    const missing = pdfs.filter((name) => !known.has(name));
    for (const name of known) {
      if (!pdfs.includes(name)) {
        log(`? ${shown}: [pdf."${name}"] has no PDF in this folder (renamed or moved? update or remove the entry)`);
        summary.orphans++;
      }
    }
    if (!missing.length && exists) continue;
    if (check) {
      if (!exists) log(`- missing ${shown}`);
      for (const name of missing) log(`- ${shown}: no entry for "${name}"`);
      summary.added += missing.length;
      summary.created += exists ? 0 : 1;
      continue;
    }

    if (!exists) {
      await writeFile(file, folderStub(rel ? rel.split("/").pop() : "BookReader", { root: !rel }));
      log(`+ created ${shown}`);
      summary.created++;
      exists = true;
    }
    for (const name of missing) {
      const { x } = await analyzePdf(path.join(LIBRARY, rel, name));
      const current = await readFile(file, "utf8");
      await appendFile(file, `${current.endsWith("\n\n") || !current ? "" : current.endsWith("\n") ? "\n" : "\n\n"}${pdfStub(name, guessMetadata(x, name))}`);
      log(`+ ${shown}: added [pdf."${name}"]`);
      summary.added++;
    }
  }
  return summary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const s = await syncMeta({ check });
  if (check) {
    const todo = s.added + s.created;
    console.log(todo ? `\n${todo} missing; run \`npm run sync\`.` : "All PDFs have meta.toml entries.");
    process.exit(todo || s.errors ? 1 : 0);
  }
  console.log(
    s.added || s.created
      ? `\nAdded ${s.added} entr${s.added === 1 ? "y" : "ies"}${s.created ? `, created ${s.created} meta.toml` : ""}. Review the guessed titles and authors, then build.`
      : "Everything is already listed.",
  );
  if (s.errors) process.exit(1);
}
