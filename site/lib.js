// Pure logic shared by the browser app and the build (scripts/build.mjs imports the tokenizer, so the
// full-text index and the search box always agree on what a "word" is). No DOM, so it is unit-tested.

// ---------- text normalization ----------

export function normalize(s) {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

// Normalize character by character, remembering which source character each output character came from,
// so matches found in normalized text can be mapped back (ligatures like "ﬁ" and "…" change length).
export function normalizeWithMap(src) {
  let norm = "";
  const map = [];
  for (let i = 0; i < src.length; i++) {
    const n = normalize(src[i]);
    for (let k = 0; k < n.length; k++) map.push(i);
    norm += n;
  }
  map.push(src.length);
  return { norm, map };
}

const SPLIT = /[^\p{L}\p{N}]+/u;

export function queryTerms(query) {
  return [...new Set(normalize(query).split(SPLIT).filter(Boolean))];
}

// ---------- full-text index ----------
// The build writes data/index/<shard>.json = { term: [docNumber, count, docNumber, count, …] },
// sharded by the first two characters of each term, so a search downloads only the shards it needs.

export const STOPWORDS = new Set(
  ("a an and are as at be been but by can do does for from had has have he her his i if in into is it its " +
    "may no not of on or our she so such than that the their them then there these they this to was we were " +
    "what when which who will with you your").split(" "),
);

const indexable = (t) => t.length >= 2 && t.length <= 32 && !STOPWORDS.has(t) && !(/^\d+$/.test(t) && t.length > 6);

export function tokenize(text) {
  return normalize(text).split(SPLIT).filter(indexable);
}

// Words of a search that are used for full-text search.
export function textTerms(query) {
  return queryTerms(query).filter(indexable);
}

export function shardOf(term) {
  const c = (ch) => (ch && /[a-z0-9]/.test(ch) ? ch : "_");
  return c(term[0]) + c(term[1]);
}

// Documents that contain every term (each term matches indexed words starting with it: "buck" → "buckets").
// getShard(name) returns a loaded shard object or undefined. → [{ n, score }] best first.
export function indexCandidates(getShard, terms) {
  let acc = null;
  for (const t of terms) {
    const shard = getShard(shardOf(t)) || {};
    const counts = new Map();
    for (const key in shard) {
      if (!key.startsWith(t)) continue;
      const post = shard[key];
      for (let i = 0; i < post.length; i += 2) counts.set(post[i], (counts.get(post[i]) || 0) + post[i + 1]);
    }
    const next = new Map();
    for (const [n, c] of counts) {
      if (acc === null) next.set(n, Math.log1p(c));
      else if (acc.has(n)) next.set(n, acc.get(n) + Math.log1p(c));
    }
    acc = next;
    if (!acc.size) break;
  }
  return [...(acc || [])].map(([n, score]) => ({ n, score })).sort((a, b) => b.score - a.score || a.n - b.n);
}

// ---------- page search inside one document ----------

const normCache = new WeakMap();
function normalizedPages(pages) {
  let n = normCache.get(pages);
  if (!n) normCache.set(pages, (n = pages.map(normalize)));
  return n;
}

export function snippet(text, term, radius = 70) {
  const { norm, map } = normalizeWithMap(text);
  const n = norm.indexOf(term);
  const clean = (x) => x.replace(/\s+/g, " ");
  if (n < 0) return { before: "", match: "", after: clean(text.slice(0, radius * 2)) };
  const at = map[n];
  const atEnd = map[n + term.length];
  let start = Math.max(0, at - radius);
  let end = Math.min(text.length, atEnd + radius);
  if (start > 0) {
    const space = text.indexOf(" ", start);
    if (space >= 0 && space < at) start = space + 1;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > atEnd) end = space;
  }
  return {
    before: (start > 0 ? "…" : "") + clean(text.slice(start, at)),
    match: text.slice(at, atEnd),
    after: clean(text.slice(atEnd, end)) + (end < text.length ? "…" : ""),
  };
}

// Pages containing every term → { count, hits: [{ page, before, match, after }] }
export function searchPages(pages, terms, maxHits = 3) {
  const ordered = [...terms].sort((a, b) => b.length - a.length); // longest first rules pages out fastest
  const norm = normalizedPages(pages);
  const hits = [];
  let count = 0;
  for (let i = 0; i < norm.length; i++) {
    if (!ordered.every((t) => norm[i].includes(t))) continue;
    count++;
    if (hits.length < maxHits) hits.push({ page: i + 1, ...snippet(pages[i], ordered[0]) });
  }
  return { count, hits };
}

// Split text into [{ text, mark }] runs around query terms, for safe highlighting with DOM nodes.
export function highlight(text, terms) {
  const src = String(text ?? "");
  if (!terms.length) return [{ text: src, mark: false }];
  const { norm, map } = normalizeWithMap(src);
  const marks = new Array(src.length).fill(false);
  for (const t of terms) {
    for (let at = norm.indexOf(t); at >= 0; at = norm.indexOf(t, at + t.length)) {
      for (let i = map[at]; i < map[at + t.length]; i++) marks[i] = true;
    }
  }
  const runs = [];
  for (let i = 0; i < src.length; i++) {
    const last = runs[runs.length - 1];
    if (last && last.mark === marks[i]) last.text += src[i];
    else runs.push({ text: src[i], mark: marks[i] });
  }
  return runs.length ? runs : [{ text: "", mark: false }];
}

// ---------- metadata search ----------

const FIELDS = [
  ["title", 10],
  ["authors", 6],
  ["tags", 5],
  ["folderTitle", 3],
  ["publisher", 2],
  ["year", 2],
  ["filename", 2],
  ["description", 2],
];

function fieldText(doc, key) {
  const v = doc[key];
  return normalize(Array.isArray(v) ? v.join(" ") : v);
}

// Every term must match some field. Matches at word starts and in the title score highest.
export function searchDocs(docs, query) {
  const terms = queryTerms(query);
  if (!terms.length) return docs.map((doc) => ({ doc, score: 0 }));
  const whole = normalize(query).trim();
  const out = [];
  for (const doc of docs) {
    let score = 0;
    let all = true;
    for (const term of terms) {
      let best = 0;
      for (const [key, weight] of FIELDS) {
        const text = fieldText(doc, key);
        const at = text.indexOf(term);
        if (at < 0) continue;
        const wordStart = at === 0 || !/[\p{L}\p{N}]/u.test(text[at - 1]);
        best = Math.max(best, weight * (wordStart ? 1.5 : 1));
      }
      if (!best) {
        all = false;
        break;
      }
      score += best;
    }
    if (!all) continue;
    const title = normalize(doc.title);
    if (title === whole) score += 50;
    else if (title.startsWith(whole)) score += 20;
    else if (title.includes(whole)) score += 10;
    out.push({ doc, score });
  }
  return out.sort((a, b) => b.score - a.score || a.doc.title.localeCompare(b.doc.title));
}

// ---------- folders, tags, sorting ----------

export const parentOf = (path) => path.split("/").slice(0, -1).join("/");

export function inFolder(doc, folder, nested = true) {
  if (!folder) return nested || doc.folder === "";
  return doc.folder === folder || (nested && doc.folder.startsWith(`${folder}/`));
}

export function childFolders(folders, path) {
  return folders
    .filter((f) => parentOf(f.path) === path)
    .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.title.localeCompare(b.title, undefined, { numeric: true }));
}

// "A/B/C" → ["A", "A/B", "A/B/C"]
export function ancestors(path) {
  const parts = path ? path.split("/") : [];
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

export function tagCounts(docs) {
  const counts = new Map();
  for (const d of docs) for (const t of d.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
}

export function withTags(docs, tags) {
  return tags.length ? docs.filter((d) => tags.every((t) => d.tags?.includes(t))) : docs;
}

const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true });

export const SORTS = {
  added: { label: "Recently added", cmp: (a, b) => (b.added || "").localeCompare(a.added || "") || byTitle(a, b) },
  title: { label: "Title", cmp: byTitle },
  author: { label: "Author", cmp: (a, b) => (a.authors?.[0] || "￿").localeCompare(b.authors?.[0] || "￿") || byTitle(a, b) },
  year: { label: "Newest", cmp: (a, b) => (b.year || 0) - (a.year || 0) || byTitle(a, b) },
  pages: { label: "Most pages", cmp: (a, b) => (b.pages || 0) - (a.pages || 0) || byTitle(a, b) },
  size: { label: "Largest", cmp: (a, b) => b.size - a.size || byTitle(a, b) },
  read: { label: "Recently read", cmp: null },
};

export function sortDocs(docs, key, recent = {}) {
  const list = [...docs];
  if (key === "read") return list.sort((a, b) => (recent[b.id]?.at || 0) - (recent[a.id]?.at || 0) || byTitle(a, b));
  return list.sort((SORTS[key] || SORTS.added).cmp);
}

// ---------- routing ----------
//   #/                              home (all documents)
//   #/f/Machine%20Learning/NLP      a folder (and its sub-folders)
//   #/favorites   #/recent
//   …?q=word&t=tag1,tag2            search / tag filter on any of the above
//   #/read/<id>/<slug>?page=3&q=w   reader

const enc = (path) => path.split("/").map(encodeURIComponent).join("/");

export function parseRoute(hash) {
  const h = String(hash || "").replace(/^#\/?/, "");
  const [pathPart, qs = ""] = h.split("?");
  const params = new URLSearchParams(qs);
  const segs = pathPart.split("/").filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  if (segs[0] === "read" && segs[1]) {
    const page = parseInt(params.get("page"), 10);
    return { view: "read", id: segs[1], rest: segs.slice(1).join("/"), page: page > 0 ? page : null, q: params.get("q") || "" };
  }
  const base = { q: params.get("q") || "", tags: (params.get("t") || "").split(",").map((t) => t.trim()).filter(Boolean) };
  if (segs[0] === "f" && segs.length > 1) return { view: "folder", folder: segs.slice(1).join("/"), ...base };
  if (segs[0] === "favorites" || segs[0] === "recent") return { view: segs[0], ...base };
  return { view: "home", ...base };
}

export function buildRoute(r) {
  const params = new URLSearchParams();
  if (r.view === "read") {
    if (r.page) params.set("page", r.page);
    if (r.q) params.set("q", r.q);
    const qs = params.toString();
    return `#/read/${encodeURIComponent(r.id)}${r.slug ? `/${encodeURIComponent(r.slug)}` : ""}${qs ? `?${qs}` : ""}`;
  }
  if (r.q) params.set("q", r.q);
  if (r.tags?.length) params.set("t", r.tags.join(","));
  const qs = params.toString().replace(/%2C/g, ",");
  const path = r.view === "folder" && r.folder ? `f/${enc(r.folder)}` : r.view === "favorites" || r.view === "recent" ? r.view : "";
  return `#/${path}${qs ? `?${qs}` : ""}`;
}

// ---------- formatting ----------

export function formatBytes(b) {
  if (!(b >= 0)) return "";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function plural(n, word, many = `${word}s`) {
  return `${n.toLocaleString()} ${n === 1 ? word : many}`;
}

export function joinAuthors(authors = [], max = 3) {
  if (!authors.length) return "";
  if (authors.length <= max) return authors.length === 2 ? authors.join(" & ") : authors.join(", ");
  return `${authors.slice(0, max).join(", ")} et al.`;
}
