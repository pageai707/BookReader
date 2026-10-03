# Code Structure

BookReader turns a folder tree of PDFs (`library/`) plus `meta.toml` files into a static single-page site on GitHub Pages. A build step extracts everything the browser needs: the catalog, folder tree, page text, a word index and thumbnails. The browser app then browses and searches that data and shows PDFs in the PDF.js viewer.

```
             build time (your Mac, or GitHub Actions)                         run time (browser)
┌───────────────────────────────────────────────────────────┐   ┌───────────────────────────────────────────┐
│ library/**/*.pdf ───┐                                     │   │ index.html + app.js + lib.js              │
│ library/**/meta.toml┼─▶ scripts/build.mjs ──▶ dist/       │──▶│  data/catalog.json      (on load)         │
│ site/* ─────────────┘    ├ smol-toml: metadata            │   │  data/index/<xx>.json   (per search word) │
│                          ├ extract.mjs (pdfjs-dist, cache)│   │  data/text/<sha>.json   (snippets)        │
│                          └ PDF.js viewer zip              │   │  <iframe> pdfjs/web/viewer.html?file=…    │
└───────────────────────────────────────────────────────────┘   └───────────────────────────────────────────┘
```

## Directory layout

```
BookReader/
├── library/                  # The PDFs. Folders = categories (any depth); a meta.toml per folder
├── site/                     # The single-page app, copied as-is into dist/
│   ├── index.html            # Shell: top bar, sidebar (category tree), library content, reader, footer
│   ├── app.js                # DOM, state, routing, full-text search flow, PDF.js integration (ES module)
│   ├── lib.js                # Pure logic shared with the build: tokenizer, index lookup, search, routes (unit-tested)
│   ├── style.css             # Theme tokens (light/dark), layout, sidebar/drawer, cards, reader + details panel
│   └── viewer-overrides.css  # Loaded into the PDF.js iframe to hide "Open file" and bookmark buttons
├── scripts/
│   ├── build.mjs             # library/ + site/ → dist/
│   ├── extract.mjs           # Reads one PDF (metadata, page text, thumbnail), cached by content hash
│   ├── catalog.mjs           # Pure helpers: meta.toml validation/stubs, titles, ids, page text (unit-tested)
│   ├── sync.mjs              # `npm run sync`: add meta.toml entries for PDFs that have none
│   ├── add.mjs               # `npm run add`: copy PDFs into library/, then sync
│   └── serve.mjs             # `npm run serve`: static server for dist/ with HTTP range support
├── tests/                    # lib.test.js (site/lib.js), catalog.test.js (scripts/catalog.mjs)
├── .github/workflows/pages.yml  # test → build → deploy to Pages on push to main
├── package.json              # deps: pdfjs-dist (pinned), @napi-rs/canvas (thumbnails), smol-toml
├── dist/                     # build output (git-ignored)
└── .cache/                   # extraction cache + downloaded viewer (git-ignored, cached in CI)
```

`BOOKREADER_LIBRARY` and `BOOKREADER_DIST` environment variables point the scripts at another library or output folder, which is handy for testing.

## `meta.toml`

One file per folder, all fields optional:

| Table | Keys |
|---|---|
| `[library]` (root only) | `title`, `description`, `repo` (link for the header's GitHub button; default: the git `origin` remote, or `GITHUB_REPOSITORY` in Actions) |
| `[folder]` | `title`, `description`, `order` (number, lower first) |
| `[pdf."file name.pdf"]` | `title`, `authors` (list; `author` also accepted), `year`, `publisher`, `tags` (list, lowercased), `description`, `url` |

`readMeta()` in `catalog.mjs` validates and normalizes each file. Unknown keys, wrong types, bad years and bad URLs become warnings that the build prints. Invalid TOML stops the build with smol-toml's line and column. `pdfStub()` and `folderStub()` generate the text that `sync` appends. They use JSON string escaping, which is valid for TOML basic strings, and `catalog.test.js` checks that the stubs read back correctly.

Values are chosen in this order: `meta.toml`, then the PDF's own metadata, then guesses. The title guess comes from `pickTitle()`. It uses the largest upright text on the first three pages, skipping rotated stamps like arXiv's and cover-image pages. If there's no usable text, it falls back to the filename. If `meta.toml` doesn't set authors, they come from the PDF's `Author` field, split on `;`, `&` and "and". If it doesn't set a year, the PDF's creation year is used.

## Build (`scripts/build.mjs`)

1. Clean `dist/` and copy `site/` into it. Download the PDF.js viewer matching `pdfjs-dist` (cached in `.cache/`) and copy it to `dist/pdfjs/`.
2. `scan()` lists every PDF and folder. `readMetas()` parses every `meta.toml`. Entries without a matching PDF are reported.
3. **Folder tree:** every folder that contains documents, directly or below, along with its ancestors, gets `{ path, name, title, description, order }`.
4. **Per PDF:** `analyzePdf()` in `extract.mjs` returns the cached extraction when the content hash hasn't changed. Otherwise it reads the PDF with PDF.js in Node: metadata, page text and a 360 px WebP thumbnail via `@napi-rs/canvas`. Identical files are skipped with a warning.
5. **Document ids:**
   - `id` is the first 12 hex characters of the content hash. It stays the same when a file is moved or renamed.
   - `slug` comes from the title and is only there to make URLs readable.
   - `legacy` is the old path-based id. The app maps old links and stored favorites and progress through it.
6. **Word index:** every page is passed through `tokenize()` from `site/lib.js`. It lowercases, strips accents, splits into words and drops stopwords and short or very long tokens. Term counts are collected per document. After sorting the documents, the build writes `data/index/<xx>.json` files, sharded by a term's first two characters (`shardOf()`), each shaped like `{ "term": [docNumber, count, …] }`. `docNumber` is the document's position in `catalog.docs`.
7. **Outputs:**
   - PDFs go to `dist/library/<same path>`.
   - Thumbnails go to `dist/thumbs/<sha>.webp`.
   - Page text goes to `dist/data/text/<sha>.json`.
   - Index shards go to `dist/data/index/`.
   - `dist/data/catalog.json` holds `{ generated, library, root, folders, shards, docs }`.

Content-hashed file names mean an updated PDF gets new URLs, so browsers never show a stale cached version.

## App (`site/`)

### Routes (hash-based, so it works on static hosting)
| URL | View |
|---|---|
| `#/` | All documents: continue-reading shelf, top-level categories, document list |
| `#/f/Machine%20Learning/NLP` | A category: breadcrumbs, description, sub-categories, documents (optionally including sub-categories) |
| `#/favorites`, `#/recent` | Starred / recently opened documents |
| `…?q=words&t=tag1,tag2` | Search and/or tag filter, scoped to the current view |
| `#/read/<id>/<slug>?page=4&q=word` | Reader at page 4, highlighting `word` |

`parseRoute()` and `buildRoute()` in `lib.js` convert between URLs and route objects. `navigate()` pushes or replaces history and calls `render()`, which also runs on `popstate` and `hashchange`.

### Library views (`renderLibrary`)
- **Sidebar:** `renderSidebar()` draws All / Recently read / Favorites and the category tree (`childFolders()`, sorted by `order` then title), with counts and expand/collapse state saved in `localStorage`. The current category and its ancestors are expanded automatically. Below 960 px the sidebar becomes a drawer opened with the menu button.
- **Scope:** `scopeFor(route)` picks the documents for the view. A folder view includes sub-folders unless "Include sub-categories" is unticked. Then `searchDocs()` (when there's a query) or `sortDocs()` runs, followed by `withTags()`.
- **Tag chips:** `tagCounts()` of the current results; the top 18 are shown, with a "+N more" button.
- **Paging:** 60 cards at a time. The "Show more" button loads the next batch automatically when scrolled into view.
- **Category tiles:** stacked thumbnails of the three newest documents, plus the description and counts.

### Full-text search (two stages, so it scales)
1. **Index lookup:** `textTerms(q)` gives the words to look up. The app fetches only their shards (`loadShard()`, cached). `indexCandidates()` treats each word as a prefix, so "buck" matches "buckets", keeps the documents that contain every word, and ranks them by summed `log(1 + count)`. This step finds which documents match without downloading any text.
2. **Snippets on demand:** for the first 10 candidates (with "Show more documents" for more), the app fetches `data/text/<sha>.json` (`loadText()`, cached). `searchPages()` then finds pages containing every word and builds snippets that link to `#/read/…?page=N&q=…`.

`normalizeWithMap()` maps normalized offsets back to the original text, so snippets and highlights stay correct around ligatures (`ﬁ`) and ellipses.

### Reader (`renderReader`)
- An `<iframe>` loads `pdfjs/web/viewer.html?file=../../<doc.file>#page=N&search=words`. It's only reloaded when the document changes.
- On `webviewerloaded`, the app sets viewer options:
  - `disablePreferences` and `disableHistory`
  - `viewerCssTheme`: follows the BookReader theme
  - `externalLinkTarget = BLANK`: links in PDFs open in a new tab
  - `enableScripting = false`: never runs JavaScript embedded in PDFs
  - `annotationEditorMode = -1`: hides the editing tools
- `viewer-overrides.css` is added with a `<link>` tag, because the viewer's Content-Security-Policy blocks inline styles.
- Page tracking uses the `updateviewarea` and `pagechanging` events, ignored until `isInitialViewSet`. Each change updates the page counter, the reading progress and the URL.
- The **details panel** (`renderInfo()`, toggled with the ⓘ button or `i`) shows the cover, authors, description, category link, year, publisher, pages, size, date added, file name, source URL, tags (each links to a filtered list) and Download / Open in new tab. It stays open on wide screens if you left it open, and opens only on request on narrow ones.

### Local state (`localStorage`, prefixed `bookreader.`)
| Key | Contents |
|---|---|
| `favorites` | array of document ids |
| `recent` | `{ id: { page, pages, at } }`, at most 100 entries |
| `sort`, `layout`, `theme`, `nested`, `info` | UI preferences |
| `expanded` | category tree folders that are expanded |

`migrateStoredIds()` converts ids saved by the first version, which were path-based, using each document's `legacy` id.

## Workflow (`.github/workflows/pages.yml`)
Runs on pushes to `main` that touch `library/`, `site/`, `scripts/`, the package files or the workflow. Steps:
1. Check out the full history (for "added" dates), including LFS files.
2. `npm ci`, then `npm test`.
3. Restore `.cache/`, so only new or changed PDFs are read.
4. `npm run build`.
5. Upload `dist/` and deploy it to Pages.

## Where to change things
| Change | Where |
|---|---|
| Allowed `meta.toml` fields / validation | `PDF_KEYS`, `cleanPdfMeta()` and `readMeta()` in `scripts/catalog.mjs` (then show the field in `renderInfo()` / `card()`) |
| Template that `sync`/`add` append | `pdfStub()` / `folderStub()` in `scripts/catalog.mjs` |
| Search ranking / field weights | `FIELDS` and `searchDocs()` in `site/lib.js` |
| What counts as a word in full-text search | `tokenize()`, `STOPWORDS` in `site/lib.js` (rebuild afterwards) |
| Sort options | `SORTS` in `site/lib.js` |
| Cards, tiles, sidebar | `card()`, `folderTile()` and `renderSidebar()` in `site/app.js`, with styles in `site/style.css` |
| Colors / theme | tokens at the top of `site/style.css` |
| PDF.js viewer behavior | the `webviewerloaded` handler in `site/app.js`, plus `site/viewer-overrides.css` |
| Thumbnail size, title detection depth | `THUMB_WIDTH` and `TITLE_PAGES` in `scripts/extract.mjs` (bump `CACHE_VERSION` to re-read PDFs) |
