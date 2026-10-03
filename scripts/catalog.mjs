// Pure helpers for turning PDFs and meta.toml files into catalog entries. No I/O, so they are unit-tested.

export const META_FILE = "meta.toml";

export function slugify(s, max = 80) {
  return (
    String(s)
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/, "") || "document"
  );
}

// "deep_learning-notes.pdf" → "Deep learning - notes"
export function prettifyFilename(name) {
  const stem = String(name).replace(/\.pdf$/i, "").replace(/[_]+/g, " ").replace(/\s*-\s*/g, " - ").trim();
  const words = stem.replace(/\s+/g, " ");
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Untitled";
}

// "Machine Learning/NLP/paper.pdf" → "Machine Learning/NLP"; files at the library root → ""
export function folderOf(relPath) {
  const parts = relPath.split("/");
  return parts.slice(0, -1).join("/");
}

// Path-based ids from the first version of BookReader ("Research/Paper 1.pdf" → "research/paper-1").
// Kept as `legacy` so old links, favorites and reading progress still resolve.
export function assignIds(relPaths) {
  const used = new Set();
  const ids = new Map();
  for (const rel of [...relPaths].sort()) {
    const base = rel.replace(/\.pdf$/i, "").split("/").map((s) => slugify(s)).join("/");
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    ids.set(rel, id);
  }
  return ids;
}

// Content-based id: survives moving or renaming the file.
export function docId(sha) {
  return sha.slice(0, 12);
}

const JUNK_TITLE = [
  /^untitled\b/i,
  /^microsoft (word|powerpoint|excel)\s*-/i,
  /^arxiv:/i,
  /^(document|title|slide \d+|presentation\d*|pdf)$/i,
  /\.(pdf|docx?|pptx?|tex|dvi|ps|indd|rtf|odt|epub)$/i,
  /^[\W\d_]+$/,
];

export function isUsefulTitle(title, filename = "") {
  const t = String(title ?? "").trim();
  if (t.length < 4 || t.length > 300) return false;
  if (JUNK_TITLE.some((re) => re.test(t))) return false;
  const stem = String(filename).replace(/\.pdf$/i, "");
  if (stem && t.toLowerCase() === stem.toLowerCase()) return false;
  return true;
}

// Guess a title from a page: the largest upright text (skips rotated margin stamps like arXiv's).
export function titleFromText(items) {
  const upright = (items || []).filter(
    (i) => i.str && i.str.trim() && Math.abs(i.transform[1]) < 0.01 && Math.abs(i.transform[2]) < 0.01,
  );
  if (!upright.length) return "";
  const size = (i) => Math.abs(i.transform[3]);
  const max = Math.max(...upright.map(size));
  return upright
    .filter((i) => size(i) >= max * 0.95)
    .map((i) => i.str.trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

// Title priority: meta.toml → useful PDF metadata → page text guess → filename.
export function pickTitle({ meta, infoTitle, textTitle, filename }) {
  if (meta?.title) return meta.title;
  if (isUsefulTitle(infoTitle, filename)) return String(infoTitle).trim().replace(/\s+/g, " ");
  if (isUsefulTitle(textTitle, filename) && textTitle.length <= 200) return textTitle;
  return prettifyFilename(filename);
}

// Text items of one page → a single string, keeping line breaks where the PDF has them.
export function pageText(items) {
  let out = "";
  for (const i of items || []) {
    if (typeof i.str !== "string") continue;
    out += i.str;
    out += i.hasEOL ? "\n" : i.str.endsWith(" ") ? "" : " ";
  }
  return out
    .replace(/-\n(?=\p{Ll})/gu, "") // re-join words hyphenated across lines
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// PDF date "D:20141214123456+01'00'" → "2014-12-14"
export function parsePdfDate(s) {
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?/.exec(String(s ?? ""));
  if (!m) return "";
  const [, y, mo = "01", d = "01"] = m;
  if (+y < 1900 || +y > 2200) return "";
  return `${y}-${mo}-${d}`;
}

export function splitList(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  return String(v ?? "")
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// PDF "Author" fields: "Noah Gift & Alfredo Deza", "A; B", "A and B". Commas are left alone ("Doe, Jane").
export function splitAuthors(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  return String(v ?? "")
    .split(/\s*(?:;|&|\band\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

// URL for a file under the site root, with each path segment encoded.
export function fileUrl(prefix, relPath) {
  return `${prefix}/${relPath.split("/").map(encodeURIComponent).join("/")}`;
}

// `git log --no-renames --diff-filter=A --format=%x00%cI --name-only` output → Map(path → first-added ISO date)
export function parseAddedDates(log, stripPrefix = "") {
  const added = new Map();
  for (const block of log.split("\0").slice(1)) {
    const [date, ...files] = block.split("\n").map((s) => s.trim()).filter(Boolean);
    for (const f of files) {
      // log is newest first, so the last date seen for a path is when it was first added
      const rel = stripPrefix && f.startsWith(stripPrefix) ? f.slice(stripPrefix.length) : f;
      added.set(rel, date);
    }
  }
  return added;
}

// ---------- meta.toml ----------
//
//   [library]                      # only in library/meta.toml
//   title = "My Library"
//
//   [folder]
//   title = "Machine Learning"     # display name (default: the folder name)
//   description = "…"
//   order = 1                      # position among sibling folders
//
//   [pdf."paper.pdf"]
//   title = "…"
//   authors = ["…"]
//   year = 2017
//   publisher = "…"
//   tags = ["…"]
//   description = "…"
//   url = "https://…"

const PDF_KEYS = new Set(["title", "authors", "author", "year", "publisher", "tags", "description", "url"]);
const FOLDER_KEYS = new Set(["title", "description", "order"]);
const LIBRARY_KEYS = new Set(["title", "description", "repo"]);

const isTable = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);

function str(v, where, key, warnings) {
  if (v == null) return undefined;
  if (typeof v !== "string") {
    warnings.push(`${where}: "${key}" should be a string`);
    return undefined;
  }
  const t = v.trim().replace(/\s+/g, " ");
  return t || undefined;
}

function strList(v, where, key, warnings, split = splitList) {
  if (v == null) return undefined;
  if (typeof v === "string") return split(v);
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    warnings.push(`${where}: "${key}" should be a list of strings, like ["a", "b"]`);
    return undefined;
  }
  const list = v.map((x) => x.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

function unknownKeys(table, allowed, where, warnings) {
  for (const k of Object.keys(table)) if (!allowed.has(k)) warnings.push(`${where}: unknown key "${k}"`);
}

export function cleanPdfMeta(raw, where, warnings) {
  if (!isTable(raw)) {
    warnings.push(`${where}: should be a table of fields`);
    return {};
  }
  unknownKeys(raw, PDF_KEYS, where, warnings);
  const out = {
    title: str(raw.title, where, "title", warnings),
    authors: strList(raw.authors ?? raw.author, where, raw.authors != null ? "authors" : "author", warnings, splitAuthors),
    publisher: str(raw.publisher, where, "publisher", warnings),
    description: str(raw.description, where, "description", warnings),
  };
  const tags = strList(raw.tags, where, "tags", warnings);
  if (tags) out.tags = [...new Set(tags.map((t) => t.toLowerCase()))];
  if (raw.year != null && raw.year !== "") {
    const y = typeof raw.year === "string" && /^\d{4}$/.test(raw.year.trim()) ? Number(raw.year) : raw.year;
    if (Number.isInteger(y) && y >= 1000 && y <= 2999) out.year = y;
    else warnings.push(`${where}: "year" should be a 4-digit year, like 2017`);
  }
  if (raw.url != null) {
    const u = str(raw.url, where, "url", warnings);
    if (u && /^https?:\/\//i.test(u)) out.url = u;
    else if (u) warnings.push(`${where}: "url" should start with http:// or https://`);
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

function cleanSimple(raw, allowed, where, warnings) {
  if (!isTable(raw)) {
    warnings.push(`${where}: should be a table of fields`);
    return {};
  }
  unknownKeys(raw, allowed, where, warnings);
  const out = { title: str(raw.title, where, "title", warnings), description: str(raw.description, where, "description", warnings) };
  if (allowed.has("repo") && raw.repo != null) {
    const u = repoUrl(str(raw.repo, where, "repo", warnings));
    if (u) out.repo = u;
    else warnings.push(`${where}: "repo" should be a URL, like "https://github.com/user/repo"`);
  }
  if (allowed.has("order") && raw.order != null) {
    if (typeof raw.order === "number" && Number.isFinite(raw.order)) out.order = raw.order;
    else warnings.push(`${where}: "order" should be a number`);
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

// Parsed TOML (an object) → { library, folder, pdfs: Map(filename → fields), warnings }
export function readMeta(raw, file) {
  const warnings = [];
  const out = { library: null, folder: {}, pdfs: new Map(), warnings };
  for (const [key, value] of Object.entries(raw || {})) {
    if (key === "folder") out.folder = cleanSimple(value, FOLDER_KEYS, `${file} [folder]`, warnings);
    else if (key === "library") out.library = cleanSimple(value, LIBRARY_KEYS, `${file} [library]`, warnings);
    else if (key === "pdf" && isTable(value)) {
      for (const [name, entry] of Object.entries(value)) {
        const where = `${file} [pdf."${name}"]`;
        if (!/\.pdf$/i.test(name)) warnings.push(`${where}: key should be the PDF's file name, like [pdf."${name}.pdf"]`);
        out.pdfs.set(name, cleanPdfMeta(entry, where, warnings));
      }
    } else {
      warnings.push(`${file}: unexpected "${key}" (use [folder], [library] or [pdf."file name.pdf"])`);
    }
  }
  return out;
}

// Git remote → browsable https URL: "git@github.com:me/repo.git" → "https://github.com/me/repo".
// Credentials in https remotes are dropped. Anything that isn't a web URL → "".
export function repoUrl(remote) {
  const r = String(remote ?? "").trim();
  if (!r) return "";
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?\/?$/.exec(r);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  try {
    const u = new URL(r);
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    return `https://${u.host}${u.pathname.replace(/\.git$/, "").replace(/\/$/, "")}`;
  } catch {
    return "";
  }
}

// ---------- writing meta.toml (used by `npm run add` / `npm run sync`) ----------

// JSON string escapes are valid TOML basic-string escapes.
export const tomlString = (s) => JSON.stringify(String(s));

export function folderStub(name, { root = false } = {}) {
  const lines = [
    "# BookReader metadata for this folder and the PDFs in it.",
    "# Edit freely: `npm run sync` only appends entries for new PDFs and never changes what you wrote.",
    "",
  ];
  if (root) {
    lines.push("[library]", `title = ${tomlString(name)}  # shown in the site header`, 'description = ""', "");
  }
  lines.push(
    "[folder]",
    `title = ${tomlString(root ? "All documents" : name)}  # display name on the site`,
    'description = ""',
    "# order = 1  # position among sibling folders (lower first)",
    "",
  );
  return lines.join("\n");
}

export function pdfStub(filename, guess = {}) {
  const lines = [`[pdf.${tomlString(filename)}]`, `title = ${tomlString(guess.title || prettifyFilename(filename))}`];
  lines.push(`authors = [${(guess.authors || []).map(tomlString).join(", ")}]`);
  lines.push(guess.year ? `# year = ${guess.year}  # from the PDF's creation date; set the publication year` : "# year = 2024");
  lines.push("tags = []", 'description = ""', '# publisher = ""', '# url = ""', "");
  return lines.join("\n");
}
