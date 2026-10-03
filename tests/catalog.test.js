import { test } from "node:test";
import assert from "node:assert/strict";
import { parse as parseToml } from "smol-toml";
import {
  assignIds, docId, fileUrl, folderOf, folderStub, isUsefulTitle, pageText, parseAddedDates, parsePdfDate, pdfStub,
  pickTitle, prettifyFilename, readMeta, repoUrl, slugify, splitAuthors, splitList, titleFromText, tomlString,
} from "../scripts/catalog.mjs";

const item = (str, size, { rotated = false, eol = false } = {}) => ({
  str,
  hasEOL: eol,
  transform: rotated ? [0, size, -size, 0, 0, 0] : [size, 0, 0, size, 0, 0],
});

test("ids: content-based, plus legacy path-based ids", () => {
  assert.equal(docId("bf47a0856ca19e175c62"), "bf47a0856ca1");
  const ids = assignIds(["Research/Paper 1.pdf", "research/paper-1.PDF", "Notes.pdf"]);
  assert.equal(ids.get("Notes.pdf"), "notes");
  assert.equal(ids.get("Research/Paper 1.pdf"), "research/paper-1");
  assert.equal(ids.get("research/paper-1.PDF"), "research/paper-1-2");
  assert.equal(slugify("Café — Été!"), "cafe-ete");
  assert.equal(slugify("!!!"), "document");
});

test("folders come from the path", () => {
  assert.equal(folderOf("Machine Learning/NLP/x.pdf"), "Machine Learning/NLP");
  assert.equal(folderOf("x.pdf"), "");
});

test("title selection prefers meta.toml, then useful metadata, then page text, then filename", () => {
  assert.equal(pickTitle({ meta: { title: "Mine" }, infoTitle: "Meta", filename: "a.pdf" }), "Mine");
  assert.equal(pickTitle({ infoTitle: "Designing Systems", textTitle: "x", filename: "a.pdf" }), "Designing Systems");
  assert.equal(pickTitle({ infoTitle: "arXiv:1409.3215v3 [cs.CL]", textTitle: "Sequence to Sequence", filename: "a.pdf" }), "Sequence to Sequence");
  assert.equal(pickTitle({ infoTitle: "Microsoft Word - report.docx", textTitle: "", filename: "my_report.pdf" }), "My report");
  assert.equal(isUsefulTitle("untitled"), false);
  assert.equal(isUsefulTitle("report", "report.pdf"), false);
  assert.equal(prettifyFilename("deep_learning-notes.pdf"), "Deep learning - notes");
});

test("page title guess uses the largest upright text and skips rotated stamps", () => {
  const items = [
    item("arXiv:1409.3215v3 [cs.CL] 14 Dec 2014", 20, { rotated: true }),
    item("Sequence to Sequence Learning", 17),
    item("with Neural Networks", 17),
    item("Ilya Sutskever", 10),
  ];
  assert.equal(titleFromText(items), "Sequence to Sequence Learning with Neural Networks");
  assert.equal(titleFromText([]), "");
});

test("pageText joins items, keeps line breaks and re-joins hyphenated words", () => {
  const items = [item("A rate lim-", 10, { eol: true }), item("iter keeps", 10), item("traffic", 10, { eol: true }), item("in   check", 10)];
  assert.equal(pageText(items), "A rate limiter keeps traffic\nin check");
});

test("readMeta validates meta.toml and reports problems", () => {
  const raw = parseToml(`
[library]
title = "My Library"

[folder]
title = "Machine Learning"
description = "Models"
order = 2

[pdf."paper.pdf"]
title = "  Attention   Is All You Need "
authors = ["Ashish Vaswani", "Noam Shazeer"]
year = 2017
tags = ["NLP", "transformers", "nlp"]
url = "https://arxiv.org/abs/1706.03762"
description = ""

[pdf."book.pdf"]
author = "Noah Gift & Alfredo Deza"
year = "2021"
tags = "mlops, devops"
autor = "typo"
url = "example.com"

[pdf."bad.pdf"]
year = 21
authors = [1, 2]

[extra]
x = 1
`);
  const m = readMeta(raw, "library/ML/meta.toml");
  assert.deepEqual(m.library, { title: "My Library" });
  assert.deepEqual(m.folder, { title: "Machine Learning", description: "Models", order: 2 });
  assert.deepEqual(m.pdfs.get("paper.pdf"), {
    title: "Attention Is All You Need",
    authors: ["Ashish Vaswani", "Noam Shazeer"],
    year: 2017,
    tags: ["nlp", "transformers"],
    url: "https://arxiv.org/abs/1706.03762",
  });
  assert.deepEqual(m.pdfs.get("book.pdf"), { authors: ["Noah Gift", "Alfredo Deza"], year: 2021, tags: ["mlops", "devops"] });
  assert.deepEqual(m.pdfs.get("bad.pdf"), {});
  const w = m.warnings.join("\n");
  assert.match(w, /\[pdf\."book\.pdf"\]: unknown key "autor"/);
  assert.match(w, /"url" should start with http/);
  assert.match(w, /\[pdf\."bad\.pdf"\]: "year" should be a 4-digit year/);
  assert.match(w, /"authors" should be a list of strings/);
  assert.match(w, /unexpected "extra"/);
});

test("generated meta.toml stubs are valid TOML and round-trip", () => {
  const text = `${folderStub("NLP")}\n${pdfStub('He said "hi" \\ bye.pdf', { title: 'A "quoted" title', authors: ["A. B"], year: 2014 })}`;
  const m = readMeta(parseToml(text), "x");
  assert.deepEqual(m.folder, { title: "NLP" });
  assert.deepEqual(m.pdfs.get('He said "hi" \\ bye.pdf'), { title: 'A "quoted" title', authors: ["A. B"] }); // year stays a comment
  assert.deepEqual(m.warnings, []);
  const root = readMeta(parseToml(folderStub("Shelf", { root: true })), "x");
  assert.deepEqual(root.library, { title: "Shelf" });
  assert.equal(tomlString("ünï\n"), '"ünï\\n"');
});

test("repository URLs from git remotes and meta.toml", () => {
  assert.equal(repoUrl("https://github.com/jmishra01/BookReader.git\n"), "https://github.com/jmishra01/BookReader");
  assert.equal(repoUrl("git@github.com:jmishra01/BookReader.git"), "https://github.com/jmishra01/BookReader");
  assert.equal(repoUrl("ssh://git@github.com/me/repo.git"), "https://github.com/me/repo");
  assert.equal(repoUrl("https://user:token@github.com/me/repo.git"), "https://github.com/me/repo"); // no credentials
  assert.equal(repoUrl("https://gitlab.com/group/sub/proj/"), "https://gitlab.com/group/sub/proj");
  assert.equal(repoUrl("/local/path/repo"), "");
  assert.equal(repoUrl(""), "");
  const ok = readMeta(parseToml('[library]\nrepo = "https://github.com/me/repo"'), "x");
  assert.deepEqual(ok.library, { repo: "https://github.com/me/repo" });
  const bad = readMeta(parseToml('[library]\nrepo = "not a url"'), "x");
  assert.match(bad.warnings.join(), /"repo" should be a URL/);
});

test("misc parsers", () => {
  assert.equal(parsePdfDate("D:20141214123456+01'00'"), "2014-12-14");
  assert.equal(parsePdfDate(""), "");
  assert.deepEqual(splitList("nlp; deep learning, ,lstm"), ["nlp", "deep learning", "lstm"]);
  assert.deepEqual(splitAuthors("Noah Gift & Alfredo Deza"), ["Noah Gift", "Alfredo Deza"]);
  assert.deepEqual(splitAuthors("Doe, Jane; Roe, Rick"), ["Doe, Jane", "Roe, Rick"]);
  assert.deepEqual(splitAuthors("Bo Guan"), ["Bo Guan"]);
  assert.equal(fileUrl("library", "My Books/C# & you.pdf"), "library/My%20Books/C%23%20%26%20you.pdf");
});

test("first-added dates from git log (newest commit first)", () => {
  const log = "\u00002026-10-05T00:00:00Z\n\nlibrary/b.pdf\n\u00002026-10-01T00:00:00Z\n\nlibrary/a.pdf\nlibrary/b.pdf\n";
  const added = parseAddedDates(log, "library/");
  assert.equal(added.get("a.pdf"), "2026-10-01T00:00:00Z");
  assert.equal(added.get("b.pdf"), "2026-10-01T00:00:00Z");
});
