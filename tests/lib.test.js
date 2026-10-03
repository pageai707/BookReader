import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ancestors, buildRoute, childFolders, formatBytes, highlight, inFolder, indexCandidates, joinAuthors, normalize,
  parseRoute, queryTerms, searchDocs, searchPages, shardOf, snippet, sortDocs, tagCounts, textTerms, tokenize, withTags,
} from "../site/lib.js";

const docs = [
  { id: "a1", title: "Sequence to Sequence Learning with Neural Networks", authors: ["Ilya Sutskever", "Oriol Vinyals"], tags: ["nlp", "lstm"], folder: "ML/NLP", folderTitle: "Machine Learning › NLP", filename: "1409.3215v3.pdf", size: 112084, pages: 9, year: 2014, added: "2026-10-02T08:00:00Z" },
  { id: "b2", title: "Designing Scalable Rate Limiting Systems", authors: ["Bo Guan"], tags: ["redis"], folder: "Systems", folderTitle: "Systems", filename: "2602.11741v1.pdf", size: 642034, pages: 27, year: 2026, added: "2026-10-01T08:00:00Z" },
  { id: "c3", title: "Café Notes", authors: [], tags: [], folder: "", folderTitle: "", filename: "cafe.pdf", size: 900, pages: 1, added: "2026-09-01T08:00:00Z" },
  { id: "d4", title: "Practical MLOps", authors: ["Noah Gift"], tags: ["mlops", "nlp"], folder: "ML", folderTitle: "Machine Learning", filename: "mlops.pdf", size: 5e6, pages: 461, year: 2021, added: "2026-09-15T08:00:00Z" },
];

test("normalize, queryTerms and tokenize fold case/accents and drop noise", () => {
  assert.equal(normalize("Café ÉCOLE"), "cafe ecole");
  assert.deepEqual(queryTerms("  Rate-limiting, RATE  "), ["rate", "limiting"]);
  assert.deepEqual(tokenize("The ﬁrst Token-Bucket is a 1234567 thing"), ["first", "token", "bucket", "thing"]);
  assert.deepEqual(textTerms("the token of a bucket"), ["token", "bucket"]);
  assert.equal(shardOf("token"), "to");
  assert.equal(shardOf("日本"), "__");
});

test("indexCandidates intersects terms, matches prefixes and ranks by frequency", () => {
  const shards = {
    to: { token: [0, 5, 2, 1], tokens: [1, 2] },
    bu: { bucket: [0, 3, 1, 1], buckets: [2, 4] },
  };
  const get = (name) => shards[name];
  assert.deepEqual(indexCandidates(get, ["token", "bucket"]).map((c) => c.n), [0, 2, 1]);
  assert.deepEqual(indexCandidates(get, ["tok", "buckets"]).map((c) => c.n), [2]); // "tok" is a prefix of token/tokens
  assert.deepEqual(indexCandidates(get, ["token", "zebra"]), []);
});

test("searchDocs requires every term across metadata fields", () => {
  assert.deepEqual(searchDocs(docs, "rate systems").map((r) => r.doc.id), ["b2"]);
  assert.deepEqual(searchDocs(docs, "cafe").map((r) => r.doc.id), ["c3"]);
  assert.deepEqual(searchDocs(docs, "vinyals").map((r) => r.doc.id), ["a1"]); // author
  assert.deepEqual(searchDocs(docs, "redis").map((r) => r.doc.id), ["b2"]); // tag
  assert.deepEqual(searchDocs(docs, "machine learning").map((r) => r.doc.id).sort(), ["a1", "d4"]); // folder title
  assert.deepEqual(searchDocs(docs, "2021").map((r) => r.doc.id), ["d4"]); // year
  assert.deepEqual(searchDocs(docs, "rate nlp"), []);
});

test("searchPages finds pages containing all terms, with snippets in original casing", () => {
  const pages = ["Intro page", "The token bucket algorithm refills tokens.", "Only bucket here", "Token ﬁll and BUCKET"];
  const { count, hits } = searchPages(pages, ["token", "bucket"]);
  assert.equal(count, 2);
  assert.deepEqual(hits.map((h) => h.page), [2, 4]);
  assert.equal(hits[1].match, "BUCKET");
  assert.equal(searchPages(pages, ["token"], 1).hits.length, 1);
});

test("snippet and highlight survive ligatures and ellipses", () => {
  const s = snippet("The ﬁrst step uses a token bucket to limit requests in the system.", "bucket", 12);
  assert.equal(s.match, "bucket");
  assert.ok(s.before.startsWith("…") && s.before.endsWith("token "));
  const runs = highlight("…the Token ﬁle", ["token", "file"]);
  assert.deepEqual(runs.filter((r) => r.mark).map((r) => r.text), ["Token", "ﬁle"]);
});

test("folders: membership, children, ancestors", () => {
  assert.equal(inFolder(docs[0], "ML"), true);
  assert.equal(inFolder(docs[0], "ML", false), false);
  assert.equal(inFolder(docs[3], "ML", false), true);
  assert.equal(inFolder(docs[0], "M"), false); // not a prefix match on names
  assert.equal(inFolder(docs[2], "", false), true);
  const folders = [
    { path: "ML", title: "Machine Learning", order: 2 },
    { path: "ML/NLP", title: "NLP" },
    { path: "Systems", title: "Systems", order: 1 },
    { path: "Art", title: "Art" },
  ];
  assert.deepEqual(childFolders(folders, "").map((f) => f.path), ["Systems", "ML", "Art"]); // order first, then title
  assert.deepEqual(childFolders(folders, "ML").map((f) => f.path), ["ML/NLP"]);
  assert.deepEqual(ancestors("A/B/C"), ["A", "A/B", "A/B/C"]);
  assert.deepEqual(ancestors(""), []);
});

test("tags and sorting", () => {
  assert.deepEqual(tagCounts(docs)[0], ["nlp", 2]);
  assert.deepEqual(withTags(docs, ["nlp", "mlops"]).map((d) => d.id), ["d4"]);
  assert.equal(withTags(docs, []).length, 4);
  assert.deepEqual(sortDocs(docs, "added").map((d) => d.id), ["a1", "b2", "d4", "c3"]);
  assert.deepEqual(sortDocs(docs, "year").map((d) => d.id), ["b2", "d4", "a1", "c3"]);
  assert.equal(sortDocs(docs, "pages")[0].id, "d4");
  assert.equal(sortDocs(docs, "author")[0].id, "b2"); // "Bo Guan"
  const recent = { c3: { at: 5 }, b2: { at: 9 } };
  assert.deepEqual(sortDocs(docs, "read", recent).map((d) => d.id).slice(0, 2), ["b2", "c3"]);
});

test("routes round-trip", () => {
  assert.deepEqual(parseRoute(""), { view: "home", q: "", tags: [] });
  assert.deepEqual(parseRoute("#/f/Machine%20Learning/NLP?q=lstm&t=nlp,deep%20learning"), {
    view: "folder", folder: "Machine Learning/NLP", q: "lstm", tags: ["nlp", "deep learning"],
  });
  const folder = { view: "folder", folder: "A & B/C#1", q: "x y", tags: ["t1", "t 2"] };
  assert.deepEqual(parseRoute(buildRoute(folder)), folder);
  assert.equal(parseRoute("#/favorites").view, "favorites");
  assert.equal(parseRoute("#/recent?q=x").q, "x");
  const read = parseRoute(buildRoute({ view: "read", id: "abc123", slug: "my-doc", page: 4, q: "neural nets" }));
  assert.deepEqual(read, { view: "read", id: "abc123", rest: "abc123/my-doc", page: 4, q: "neural nets" });
  // links from the first version still parse; the app resolves `rest` through the legacy id map
  assert.equal(parseRoute("#/read/research/1409-3215v3?page=-3").rest, "research/1409-3215v3");
  assert.equal(buildRoute({ view: "home" }), "#/");
});

test("formatting", () => {
  assert.equal(formatBytes(900), "900 B");
  assert.equal(formatBytes(112084), "109 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
  assert.equal(formatBytes(3 * 1024 ** 3), "3.0 GB");
  assert.equal(joinAuthors(["A", "B"]), "A & B");
  assert.equal(joinAuthors(["A", "B", "C", "D"]), "A, B, C et al.");
  assert.equal(joinAuthors([]), "");
});
