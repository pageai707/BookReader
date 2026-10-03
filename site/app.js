import {
  SORTS, ancestors, buildRoute, childFolders, formatBytes, formatDate, highlight, inFolder, indexCandidates, joinAuthors,
  parentOf, parseRoute, plural, queryTerms, searchDocs, searchPages, shardOf, sortDocs, tagCounts, textTerms, withTags,
} from "./lib.js";

// ---------- small helpers ----------

const $ = (sel) => document.querySelector(sel);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  node.append(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return node;
}

// replaceChildren() that skips null/false, like el()
const fill = (node, ...children) => node.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));

function svg(markup) {
  const t = document.createElement("template");
  t.innerHTML = markup.trim();
  return t.content.firstChild;
}

const ICONS = {
  star: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9l-5.3 2.8 1-5.9-4.2-4.1 5.9-.8z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  auto: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/></svg>',
  light: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  dark: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
};

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`bookreader.${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`bookreader.${key}`, JSON.stringify(value));
    } catch {
      /* storage unavailable (private mode): features still work for this visit */
    }
  },
};

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

const marked = (text, terms) => highlight(text, terms).map((r) => (r.mark ? el("mark", {}, r.text) : r.text));

// ---------- state ----------

const PAGE_SIZE = 60;
const TEXT_PAGE = 10;
const TOP_TAGS = 18;

const state = {
  catalog: null,
  docs: [],
  byId: new Map(),
  folders: [],
  folderByPath: new Map(),
  folderCount: new Map(), // path → number of documents in it and below
  legacy: new Map(), // old path-based id → id
  favorites: new Set(store.get("favorites", [])),
  recent: store.get("recent", {}), // id → { page, pages, at }
  sort: store.get("sort", "added"),
  layout: store.get("layout", "grid"),
  theme: store.get("theme", "auto"),
  nested: store.get("nested", true),
  infoOpen: store.get("info", false),
  expanded: new Set(store.get("expanded", [])),
  showAllTags: false,
  limit: PAGE_SIZE,
  listKey: "",
  view: null,
  enteredReaderFromLibrary: false,
  libraryHash: "#/", // last library URL, so the reader can return to it
  returnTo: "#/",
};

const shardCache = new Map(); // name → { promise, value }
const textCache = new Map(); // doc id → Promise<pages[]>
const textSearch = { key: null, seq: 0, candidates: [], shown: 0, terms: [], route: null };

const save = {
  favorites: () => store.set("favorites", [...state.favorites]),
  recent: () => store.set("recent", state.recent),
  expanded: () => store.set("expanded", [...state.expanded]),
};

function toggleFavorite(id) {
  if (state.favorites.has(id)) state.favorites.delete(id);
  else state.favorites.add(id);
  save.favorites();
  return state.favorites.has(id);
}

function markRead(id, page, pages) {
  const prev = state.recent[id] || {};
  state.recent[id] = { page: page || prev.page || 1, pages: pages || prev.pages || null, at: Date.now() };
  const ids = Object.keys(state.recent).sort((a, b) => state.recent[b].at - state.recent[a].at);
  for (const old of ids.slice(100)) delete state.recent[old];
  save.recent();
}

// ---------- navigation ----------

function navigate(route, { replace = false } = {}) {
  const hash = buildRoute(route);
  if (hash !== location.hash && !(hash === "#/" && !location.hash)) {
    history[replace ? "replaceState" : "pushState"](null, "", hash);
  }
  render();
}

const currentRoute = () => parseRoute(location.hash);
const readHref = (doc, page, q) => buildRoute({ view: "read", id: doc.id, slug: doc.slug, page, q });
const folderHref = (path, extra = {}) => buildRoute(path ? { view: "folder", folder: path, ...extra } : { view: "home", ...extra });

window.addEventListener("popstate", render);
window.addEventListener("hashchange", render);

// ---------- elements ----------

const els = {
  q: $("#q"),
  layoutRoot: $("#layout"),
  library: $("#library"),
  reader: $("#reader"),
  sidebar: $("#sidebar"),
  tree: $("#tree"),
  scrim: $("#scrim"),
  crumbs: $("#crumbs"),
  pageTitle: $("#page-title"),
  pageDesc: $("#page-desc"),
  continue: $("#continue"),
  continueRow: $("#continue-row"),
  subfolders: $("#subfolders"),
  folderGrid: $("#folder-grid"),
  results: $("#results"),
  resultsTitle: $("#results-title"),
  resultsNote: $("#results-note"),
  nestedWrap: $("#nested-wrap"),
  nested: $("#nested"),
  sort: $("#sort"),
  tags: $("#tags"),
  docs: $("#docs"),
  more: $("#more"),
  textResults: $("#text-results"),
  textHits: $("#text-hits"),
  textNote: $("#text-note"),
  textMore: $("#text-more"),
  empty: $("#empty"),
  footer: $("#footer"),
  frame: $("#viewer"),
  info: $("#info"),
};

// ---------- controls ----------

for (const [key, { label }] of Object.entries(SORTS)) els.sort.append(el("option", { value: key }, label));
els.sort.value = SORTS[state.sort] ? state.sort : "added";
els.sort.addEventListener("change", () => {
  state.sort = els.sort.value;
  store.set("sort", state.sort);
  render();
});

for (const b of document.querySelectorAll("[data-layout]")) {
  b.addEventListener("click", () => {
    state.layout = b.dataset.layout;
    store.set("layout", state.layout);
    render();
  });
}

els.nested.checked = state.nested;
els.nested.addEventListener("change", () => {
  state.nested = els.nested.checked;
  store.set("nested", state.nested);
  render();
});

$("#more-btn").addEventListener("click", () => {
  state.limit += PAGE_SIZE;
  renderLibrary(currentRoute(), { keepLimit: true });
});
// Load the next page automatically when the "Show more" button scrolls into view.
new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting) && !els.more.hidden) $("#more-btn").click();
}, { rootMargin: "400px" }).observe(els.more);

$("#text-more-btn").addEventListener("click", () => showMoreText());

let searchTimer;
function submitSearch() {
  const r = currentRoute();
  const q = els.q.value.trim();
  const base = r.view === "read" ? { view: "home" } : r;
  navigate({ ...base, q, tags: r.tags }, { replace: r.view !== "read" && Boolean(r.q) === Boolean(q) });
}
els.q.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(submitSearch, 160);
});
els.q.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && els.q.value) {
    e.stopPropagation();
    els.q.value = "";
    submitSearch();
  } else if (e.key === "Enter") {
    clearTimeout(searchTimer);
    submitSearch();
  }
});

// Sidebar drawer (small screens)
function setDrawer(open) {
  document.body.classList.toggle("drawer-open", open);
  els.scrim.hidden = !open;
  $("#menu").setAttribute("aria-expanded", String(open));
}
$("#menu").addEventListener("click", () => setDrawer(!document.body.classList.contains("drawer-open")));
els.scrim.addEventListener("click", () => setDrawer(false));
els.sidebar.addEventListener("click", (e) => {
  if (e.target.closest("a")) setDrawer(false);
});

// ---------- cards ----------

function favButton(doc) {
  const on = state.favorites.has(doc.id);
  return el(
    "button",
    {
      type: "button",
      class: "fav",
      "aria-pressed": String(on),
      "aria-label": on ? `Remove ${doc.title} from favorites` : `Add ${doc.title} to favorites`,
      title: on ? "Remove from favorites" : "Add to favorites",
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleFavorite(doc.id);
        renderSidebarCounts();
        const btn = e.currentTarget;
        const now = state.favorites.has(doc.id);
        btn.setAttribute("aria-pressed", String(now));
        btn.title = now ? "Remove from favorites" : "Add to favorites";
        if (currentRoute().view === "favorites") render();
      },
    },
    svg(ICONS.star),
  );
}

function metaLine(doc) {
  return [doc.year, doc.pages && plural(doc.pages, "page"), formatBytes(doc.size)].filter(Boolean).join(" · ");
}

function card(doc, terms, { page } = {}) {
  const r = state.recent[doc.id];
  const pages = doc.pages || r?.pages;
  const progress = r && pages ? Math.min(1, r.page / pages) : 0;
  const authors = joinAuthors(doc.authors, 2);
  return el(
    "article",
    { class: "card" },
    el(
      "div",
      { class: "cover" },
      doc.thumb
        ? el("img", { src: doc.thumb, alt: "", loading: "lazy", decoding: "async" })
        : el("div", { class: "cover-fallback" }, doc.title.slice(0, 80)),
      progress > 0 ? el("div", { class: "progress", title: `Page ${r.page} of ${pages}` }, el("span", { style: `width:${(progress * 100).toFixed(1)}%` })) : null,
    ),
    el(
      "div",
      { class: "card-body" },
      el("h3", { class: "card-title" }, el("a", { href: readHref(doc, page), title: doc.title }, marked(doc.title, terms))),
      el("p", { class: "card-author" }, authors ? marked(authors, terms) : doc.folderTitle || " "),
      state.layout === "list" ? el("p", { class: "card-folder" }, doc.folderTitle || "—") : null,
      el("p", { class: "card-meta" }, page ? `Page ${page} of ${pages || "?"}` : metaLine(doc)),
    ),
    favButton(doc),
  );
}

function folderTile(f) {
  const docs = state.docs.filter((d) => inFolder(d, f.path)).sort(SORTS.added.cmp).slice(0, 3);
  const subs = childFolders(state.folders, f.path).length;
  return el(
    "a",
    { class: "folder", href: folderHref(f.path) },
    el("div", { class: "stack", "aria-hidden": "true" }, (docs.length ? docs : [null]).map((d) => (d?.thumb ? el("img", { src: d.thumb, alt: "", loading: "lazy" }) : el("div", { class: "ph" })))),
    el(
      "div",
      { class: "folder-text" },
      el("div", { class: "folder-title" }, f.title),
      f.description ? el("div", { class: "folder-desc" }, f.description) : null,
      el("div", { class: "folder-meta" }, [plural(state.folderCount.get(f.path) || 0, "document"), subs ? plural(subs, "sub-category", "sub-categories") : null].filter(Boolean).join(" · ")),
    ),
  );
}

// ---------- sidebar ----------

function renderSidebarCounts() {
  $("#count-all").textContent = state.docs.length.toLocaleString();
  const fav = state.docs.filter((d) => state.favorites.has(d.id)).length;
  $("#count-fav").textContent = fav ? fav.toLocaleString() : "";
  const recent = Object.keys(state.recent).filter((id) => state.byId.has(id)).length;
  $("#count-recent").textContent = recent ? recent.toLocaleString() : "";
}

function renderSidebar(route) {
  for (const a of document.querySelectorAll("[data-nav]")) {
    const on = a.dataset.nav === route.view;
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  renderSidebarCounts();

  const active = route.view === "folder" ? route.folder : null;
  if (active) for (const p of ancestors(active)) state.expanded.add(p); // reveal the open folder and its children

  const items = (path) =>
    childFolders(state.folders, path).map((f) => {
      const hasKids = childFolders(state.folders, f.path).length > 0;
      const open = hasKids && state.expanded.has(f.path);
      return el(
        "li",
        { role: "treeitem", "aria-expanded": hasKids ? String(open) : null, "aria-selected": String(f.path === active) },
        el(
          "div",
          { class: "tree-row" },
          hasKids
            ? el(
                "button",
                {
                  type: "button",
                  class: "tree-toggle",
                  "aria-expanded": String(open),
                  "aria-label": `${open ? "Collapse" : "Expand"} ${f.title}`,
                  onclick: () => {
                    if (state.expanded.has(f.path)) state.expanded.delete(f.path);
                    else state.expanded.add(f.path);
                    save.expanded();
                    renderSidebar(currentRoute());
                  },
                },
                svg(ICONS.chevron),
              )
            : el("span", { class: "tree-spacer" }),
          el(
            "a",
            { class: "tree-link", href: folderHref(f.path), "aria-current": f.path === active ? "page" : null, title: f.description || f.title },
            el("span", { class: "label" }, f.title),
            el("span", { class: "count" }, (state.folderCount.get(f.path) || 0).toLocaleString()),
          ),
        ),
        open ? el("ul", { role: "group" }, items(f.path)) : null,
      );
    });

  els.tree.replaceChildren(...items(""));
  $(".side-heading").hidden = state.folders.length === 0;
}

// ---------- library view ----------

function scopeFor(route) {
  switch (route.view) {
    case "folder":
      return state.docs.filter((d) => inFolder(d, route.folder, state.nested));
    case "favorites":
      return state.docs.filter((d) => state.favorites.has(d.id));
    case "recent":
      return sortDocs(state.docs.filter((d) => state.recent[d.id]), "read", state.recent);
    default:
      return state.docs;
  }
}

function renderHeader(route, folder) {
  const crumbs = [];
  if (route.view === "folder" && folder) {
    crumbs.push(el("a", { href: "#/" }, "All documents"));
    for (const p of ancestors(parentOf(folder.path))) {
      crumbs.push(el("span", { class: "sep", "aria-hidden": "true" }, "›"), el("a", { href: folderHref(p) }, state.folderByPath.get(p)?.title || p));
    }
  }
  els.crumbs.replaceChildren(...crumbs);

  const lib = state.catalog.library;
  const titles = {
    home: [lib.title, lib.description],
    favorites: ["Favorites", "Documents you starred. Favorites are saved in this browser."],
    recent: ["Recently read", "Documents you opened, most recent first."],
    folder: [folder?.title, folder?.description],
  };
  const [title, desc] = titles[route.view] || titles.home;
  els.pageTitle.textContent = title;
  els.pageDesc.textContent = desc || "";
  document.title = route.q ? `“${route.q}” · ${lib.title}` : route.view === "home" ? lib.title : `${title} · ${lib.title}`;
}

function renderTags(route, docs) {
  const counts = tagCounts(docs);
  const selected = new Set(route.tags);
  for (const t of selected) if (!counts.some(([x]) => x === t)) counts.unshift([t, 0]);
  if (!counts.length) {
    els.tags.replaceChildren();
    return;
  }
  const shown = state.showAllTags ? counts : counts.filter(([t], i) => i < TOP_TAGS || selected.has(t));
  const toggle = (t) => {
    const tags = selected.has(t) ? route.tags.filter((x) => x !== t) : [...route.tags, t];
    navigate({ ...route, tags }, { replace: true });
  };
  const chips = [
    ...shown.map(([t, n]) =>
      el("button", { type: "button", class: "tag", "aria-pressed": String(selected.has(t)), onclick: () => toggle(t) }, `#${t}`, el("span", { class: "count" }, String(n))),
    ),
    counts.length > shown.length || state.showAllTags
      ? el(
          "button",
          {
            type: "button",
            class: "tag more",
            onclick: () => {
              state.showAllTags = !state.showAllTags;
              renderTags(currentRoute(), docs);
            },
          },
          state.showAllTags ? "Fewer tags" : `+${counts.length - shown.length} more`,
        )
      : null,
  ];
  fill(els.tags, chips);
}

function renderLibrary(route, { keepLimit = false } = {}) {
  if (document.activeElement !== els.q) els.q.value = route.q;
  for (const b of document.querySelectorAll("[data-layout]")) b.setAttribute("aria-pressed", String(b.dataset.layout === state.layout));
  els.docs.className = state.layout === "list" ? "grid list" : "grid";

  const folder = route.view === "folder" ? state.folderByPath.get(route.folder) : null;
  if (route.view === "folder" && !folder) {
    toast("That category no longer exists");
    navigate({ view: "home", q: route.q }, { replace: true });
    return;
  }
  renderHeader(route, folder);

  if (!state.docs.length) {
    for (const s of [els.continue, els.subfolders, els.results, els.textResults]) s.hidden = true;
    showEmpty(
      "Your library is empty",
      el("p", {}, "Put PDFs in the ", el("code", {}, "library/"), " folder (sub-folders become categories), describe them in ", el("code", {}, "meta.toml"), ", then push:"),
      el("pre", {}, 'npm run add -- ~/Downloads/papers --to "Machine Learning/NLP"\ngit add library && git commit -m "Add PDFs" && git push'),
    );
    return;
  }

  const terms = queryTerms(route.q);
  const searching = Boolean(route.q);
  const scope = scopeFor(route);

  // Continue reading (home only)
  const recentDocs = Object.entries(state.recent)
    .filter(([id]) => state.byId.has(id))
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, 12)
    .map(([id, r]) => ({ doc: state.byId.get(id), page: r.page }));
  const showShelf = route.view === "home" && !searching && !route.tags.length && recentDocs.length > 0;
  els.continue.hidden = !showShelf;
  if (showShelf) els.continueRow.replaceChildren(...recentDocs.map(({ doc, page }) => card(doc, [], { page })));

  // Sub-categories
  const subs = route.view === "home" || route.view === "folder" ? childFolders(state.folders, route.view === "folder" ? route.folder : "") : [];
  els.subfolders.hidden = searching || route.tags.length > 0 || !subs.length;
  if (!els.subfolders.hidden) {
    $("#subfolders-title").textContent = route.view === "folder" ? "Sub-categories" : "Categories";
    els.folderGrid.replaceChildren(...subs.map(folderTile));
  }

  // Documents
  const matched = searching ? searchDocs(scope, route.q).map((r) => r.doc) : route.view === "recent" ? scope : sortDocs(scope, state.sort, state.recent);
  const list = withTags(matched, route.tags);
  renderTags(route, matched);

  const listKey = JSON.stringify([route, state.sort, state.layout, state.nested]);
  if (!keepLimit && listKey !== state.listKey) state.limit = PAGE_SIZE;
  state.listKey = listKey;

  els.nestedWrap.hidden = route.view !== "folder" || !childFolders(state.folders, route.folder).length || searching;
  els.sort.disabled = searching || route.view === "recent";
  els.sort.title = searching ? "Search results are sorted by relevance" : "";
  els.resultsTitle.textContent = searching ? (list.length ? "Matching documents" : "No matching titles") : "Documents";
  els.resultsNote.textContent = list.length ? plural(list.length, "document") : "";
  els.results.hidden = searching && !list.length && !route.tags.length;
  els.docs.replaceChildren(...list.slice(0, state.limit).map((d) => card(d, terms)));
  els.more.hidden = list.length <= state.limit;
  $("#more-btn").textContent = `Show more (${(list.length - state.limit).toLocaleString()} left)`;

  if (!searching && !list.length) {
    showEmpty(
      route.view === "favorites" ? "No favorites yet" : route.view === "recent" ? "Nothing read yet" : "No documents here",
      el("p", {}, route.view === "favorites" ? "Tap the star on any document to keep it here." : route.tags.length ? "No documents have all of the selected tags." : "Open a document to start reading."),
    );
  } else {
    els.empty.hidden = true;
  }

  runTextSearch(route, withTags(scope, route.tags), list.length);
}

function showEmpty(title, ...body) {
  els.empty.replaceChildren(el("h2", {}, title), ...body);
  els.empty.hidden = false;
}

// ---------- full-text search ----------

function loadShard(name) {
  let entry = shardCache.get(name);
  if (!entry) {
    entry = { value: null };
    entry.promise = fetch(`data/index/${name}.json`)
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}))
      .then((v) => (entry.value = v));
    shardCache.set(name, entry);
  }
  return entry.promise;
}

function loadText(doc) {
  if (!textCache.has(doc.id)) {
    textCache.set(
      doc.id,
      fetch(doc.text)
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => []),
    );
  }
  return textCache.get(doc.id);
}

async function runTextSearch(route, scope, metaCount) {
  const terms = textTerms(route.q);
  const key = JSON.stringify([route.view, route.folder, route.q, route.tags, state.nested]);
  if (!route.q || !terms.length || !state.catalog.shards?.length) {
    textSearch.key = null;
    els.textResults.hidden = true;
    if (route.q && !metaCount) showNoResults(route);
    return;
  }
  if (textSearch.key === key) return; // already showing results for this search
  textSearch.key = key;
  const seq = ++textSearch.seq;

  els.textResults.hidden = false;
  els.textHits.replaceChildren();
  els.textMore.hidden = true;
  els.textNote.replaceChildren(el("span", { class: "spinner" }), "Searching inside documents…");

  const available = new Set(state.catalog.shards);
  const names = [...new Set(terms.map(shardOf))];
  const loaded = await Promise.all(names.filter((n) => available.has(n)).map(loadShard));
  if (seq !== textSearch.seq) return;

  const ids = new Set(scope.map((d) => d.id));
  const candidates =
    loaded.length < names.length
      ? [] // some word isn't in any document
      : indexCandidates((n) => shardCache.get(n)?.value, terms)
          .map((c) => state.docs[c.n])
          .filter((d) => d && ids.has(d.id));

  Object.assign(textSearch, { candidates, shown: 0, terms, route });
  if (!candidates.length) {
    els.textNote.textContent = "No document contains all of these words";
    if (!metaCount) {
      els.textResults.hidden = true;
      showNoResults(route);
    }
    return;
  }
  els.textNote.textContent = `${plural(candidates.length, "document")} contain${candidates.length === 1 ? "s" : ""} these words`;
  showMoreText();
}

function showMoreText() {
  const { candidates, terms, route } = textSearch;
  const seq = textSearch.seq;
  const next = candidates.slice(textSearch.shown, textSearch.shown + TEXT_PAGE);
  textSearch.shown += next.length;
  for (const doc of next) {
    const li = el(
      "li",
      { class: "hit" },
      el("div", { class: "hit-head" }, el("a", { href: readHref(doc, null, route.q) }, doc.title), el("span", { class: "muted" }, [joinAuthors(doc.authors, 2), doc.folderTitle].filter(Boolean).join(" · "))),
      el("div", { class: "pending" }, el("span", { class: "spinner" }), "Finding pages…"),
    );
    els.textHits.append(li);
    loadText(doc).then((pages) => {
      if (seq !== textSearch.seq) return;
      const { count, hits } = searchPages(pages, terms);
      const head = li.firstChild;
      head.firstChild.href = readHref(doc, hits[0]?.page, route.q);
      head.lastChild.textContent = [count ? plural(count, "matching page") : null, joinAuthors(doc.authors, 2), doc.folderTitle].filter(Boolean).join(" · ");
      li.lastChild.replaceWith(
        count
          ? el(
              "div",
              {},
              el(
                "ul",
                {},
                hits.map((h) =>
                  el(
                    "li",
                    {},
                    el("a", { class: "snippet", href: readHref(doc, h.page, route.q) }, el("span", { class: "page-tag" }, `p. ${h.page}`), marked(h.before, terms), el("mark", {}, h.match), marked(h.after, terms)),
                  ),
                ),
              ),
              count > hits.length ? el("a", { class: "more", href: readHref(doc, hits[0].page, route.q) }, `${plural(count - hits.length, "more page")} — open to see all matches`) : null,
            )
          : el("div", { class: "pending" }, "The words appear on different pages. ", el("a", { class: "more", href: readHref(doc, null, route.q) }, "Open and search")),
      );
    });
  }
  els.textMore.hidden = textSearch.shown >= candidates.length;
}

function showNoResults(route) {
  const inScope = route.view !== "home";
  showEmpty(
    `No results for “${route.q}”`,
    el(
      "p",
      {},
      inScope || route.tags.length
        ? el("a", { href: buildRoute({ view: "home", q: route.q }) }, "Search all documents instead")
        : "Try fewer or different words.",
    ),
  );
}

// ---------- reader view ----------

let viewerDocId = null;
let viewerApp = null;

const THEME_TO_VIEWER = { auto: 0, light: 1, dark: 2 };

// The PDF.js viewer announces itself to the embedding page before it starts; configure it here.
document.addEventListener("webviewerloaded", (e) => {
  const win = e.detail?.source;
  if (!win || win !== els.frame.contentWindow) return;
  const opts = win.PDFViewerApplicationOptions;
  opts.set("disablePreferences", true);
  opts.set("disableHistory", true); // keep PDF.js out of the browser history, so Back returns to the library
  opts.set("defaultUrl", "");
  opts.set("viewerCssTheme", THEME_TO_VIEWER[state.theme] ?? 0);
  opts.set("externalLinkTarget", 2); // links inside PDFs open in a new tab
  opts.set("enableScripting", false); // never run JavaScript embedded in PDFs
  opts.set("annotationEditorMode", -1); // hide the editing tools; edits could not be saved anyway
  hookViewer(win, viewerDocId);
});

function hookViewer(win, docId) {
  const app = win.PDFViewerApplication;
  viewerApp = app;
  app.initializedPromise.then(() => {
    // The viewer's CSP only allows same-origin stylesheets, so the overrides are a file, not inline CSS.
    const css = win.document.createElement("link");
    css.rel = "stylesheet";
    css.href = new URL("viewer-overrides.css", location.href).href;
    win.document.head.append(css);

    // Ignore page events until PDF.js has applied the requested page, so page 1 isn't recorded by mistake.
    let lastPage = null;
    const report = (page) => {
      if (!app.isInitialViewSet || !page || page === lastPage) return;
      lastPage = page;
      onViewerPage(docId, page, app.pagesCount);
    };
    app.eventBus.on("updateviewarea", ({ location }) => report(location?.pageNumber));
    app.eventBus.on("pagechanging", ({ pageNumber }) => report(pageNumber));

    win.addEventListener("keydown", (e) => {
      if (e.defaultPrevented) return;
      const active = win.document.activeElement;
      if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;
      // PDF.js handles Escape itself (closing its find bar or menu) and marks the event as handled.
      if (e.key === "Escape" && !app.findBar?.opened && !win.document.fullscreenElement) leaveReader();
      else if (e.key === "i" && !e.metaKey && !e.ctrlKey && !e.altKey) toggleInfo();
    });
  });
}

function onViewerPage(docId, page, pages) {
  if (docId !== viewerDocId || state.view !== "read" || !page) return;
  $("#r-page").textContent = pages ? `${page} / ${pages}` : `p. ${page}`;
  markRead(docId, page, pages);
  const r = currentRoute();
  if (r.view === "read" && r.id === docId && r.page !== page) {
    const doc = state.byId.get(docId);
    history.replaceState(null, "", buildRoute({ view: "read", id: docId, slug: doc?.slug, page, q: r.q }));
  }
}

function viewerUrl(doc, page, q) {
  const hash = new URLSearchParams();
  if (page) hash.set("page", page);
  if (q) hash.set("search", q);
  const h = hash.toString();
  return `pdfjs/web/viewer.html?file=${encodeURIComponent(`../../${doc.file}`)}${h ? `#${h}` : ""}`;
}

function renderInfo(doc) {
  const row = (label, value) => (value ? [el("dt", {}, label), el("dd", {}, value)] : null);
  const folderLink = doc.folder ? el("a", { href: folderHref(doc.folder) }, doc.folderTitle) : "—";
  fill(
    els.info,
    doc.thumb ? el("img", { class: "info-cover", src: doc.thumb, alt: "" }) : null,
    el("h2", {}, doc.title),
    doc.authors.length ? el("p", { class: "info-authors" }, joinAuthors(doc.authors, 8)) : null,
    doc.description ? el("p", { class: "info-desc" }, doc.description) : null,
    el(
      "dl",
      {},
      row("Category", folderLink),
      row("Year", doc.year ? String(doc.year) : ""),
      row("Publisher", doc.publisher),
      row("Pages", doc.pages ? doc.pages.toLocaleString() : ""),
      row("Size", formatBytes(doc.size)),
      row("Added", formatDate(doc.added)),
      row("File", doc.filename),
      row("Source", doc.url ? el("a", { href: doc.url, target: "_blank", rel: "noopener" }, doc.url.replace(/^https?:\/\//, "")) : ""),
    ),
    doc.tags.length ? el("div", { class: "tags" }, doc.tags.map((t) => el("a", { class: "tag", href: buildRoute({ view: "home", tags: [t] }) }, `#${t}`))) : null,
    el(
      "div",
      { class: "info-actions" },
      el("a", { class: "btn", href: doc.file, download: doc.filename }, "Download"),
      el("a", { class: "btn", href: viewerUrl(doc, viewerApp?.page), target: "_blank", rel: "noopener" }, "Open in new tab"),
    ),
  );
}

function toggleInfo() {
  const open = els.info.hidden;
  state.infoOpen = open;
  store.set("info", open);
  els.info.hidden = !open;
  $("#r-info").setAttribute("aria-pressed", String(open));
}
$("#r-info").addEventListener("click", () => toggleInfo());

// Load a document into the viewer iframe without adding a browser-history entry. Setting `src` would add one,
// so Back would first step the iframe to the previously opened PDF (a blank page) instead of leaving the reader.
function loadViewer(url) {
  const win = els.frame.contentWindow;
  if (win) win.location.replace(new URL(url, location.href).href);
  else els.frame.src = url;
}

function renderReader(route) {
  let doc = state.byId.get(route.id);
  if (!doc && state.legacy.has(route.rest)) doc = state.byId.get(state.legacy.get(route.rest));
  if (!doc) {
    toast("That document is no longer in the library");
    navigate({ view: "home" }, { replace: true });
    return;
  }
  if (doc.id !== route.id) {
    history.replaceState(null, "", readHref(doc, route.page, route.q)); // upgrade an old-style link
  }
  document.title = `${doc.title} · ${state.catalog.library.title}`;
  $("#r-title").textContent = doc.title;
  $("#r-sub").textContent = [joinAuthors(doc.authors, 2), doc.folderTitle, doc.pages && plural(doc.pages, "page")].filter(Boolean).join(" · ");
  $("#r-download").href = doc.file;
  $("#r-download").setAttribute("download", doc.filename);
  updateReaderFav(doc);
  renderInfo(doc);
  // The panel covers the page on narrow screens, so there it only opens on request.
  const showInfo = state.infoOpen && innerWidth > 800;
  els.info.hidden = !showInfo;
  $("#r-info").setAttribute("aria-pressed", String(showInfo));

  if (viewerDocId !== doc.id) {
    viewerDocId = doc.id;
    viewerApp = null;
    $("#r-page").textContent = "";
    loadViewer(viewerUrl(doc, route.page, route.q));
  } else if (route.page && viewerApp && viewerApp.page !== route.page) {
    viewerApp.page = route.page;
  }
  markRead(doc.id, route.page, doc.pages);
  requestAnimationFrame(() => els.frame.focus());
}

function updateReaderFav(doc) {
  const on = state.favorites.has(doc.id);
  const b = $("#r-fav");
  b.setAttribute("aria-pressed", String(on));
  b.setAttribute("aria-label", on ? "Remove from favorites" : "Add to favorites");
}

$("#r-fav").addEventListener("click", () => {
  const doc = state.byId.get(viewerDocId);
  if (!doc) return;
  const on = toggleFavorite(doc.id);
  updateReaderFav(doc);
  toast(on ? "Added to favorites" : "Removed from favorites");
});

$("#r-copy").addEventListener("click", async () => {
  const doc = state.byId.get(viewerDocId);
  if (!doc) return;
  const page = viewerApp?.page || currentRoute().page;
  const url = new URL(readHref(doc, page), location.href).href;
  try {
    await navigator.clipboard.writeText(url);
    toast(page ? `Link to page ${page} copied` : "Link copied");
  } catch {
    prompt("Copy this link:", url);
  }
});

function leaveReader() {
  const libraryRoute = parseRoute(state.returnTo || "#/");
  if (!state.enteredReaderFromLibrary) return navigate(libraryRoute, { replace: true });
  const readerHash = location.hash;
  history.back();
  // Safety net: if Back didn't leave the reader (some other history entry was in the way), go to the library directly.
  setTimeout(() => {
    if (state.view === "read" && location.hash === readerHash) navigate(libraryRoute, { replace: true });
  }, 250);
}
$("#back").addEventListener("click", leaveReader);

// ---------- global keys ----------

document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (e.key === "Escape" && document.body.classList.contains("drawer-open")) {
    setDrawer(false);
  } else if (state.view === "read" && e.key === "Escape") {
    e.preventDefault();
    leaveReader();
  } else if (state.view === "read" && e.key === "i" && !typing && !e.metaKey && !e.ctrlKey) {
    toggleInfo();
  } else if (state.view !== "read" && e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    els.q.focus();
    els.q.select();
  }
});

// ---------- theme ----------

const THEMES = ["auto", "light", "dark"];
function applyTheme() {
  if (state.theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = state.theme;
  const b = $("#theme");
  b.replaceChildren(svg(ICONS[state.theme]));
  const label = { auto: "Theme: system", light: "Theme: light", dark: "Theme: dark" }[state.theme];
  b.setAttribute("aria-label", label);
  b.title = label;
}
$("#theme").addEventListener("click", () => {
  state.theme = THEMES[(THEMES.indexOf(state.theme) + 1) % THEMES.length];
  store.set("theme", state.theme);
  applyTheme();
  toast({ auto: "Following system theme", light: "Light theme", dark: "Dark theme" }[state.theme]);
});
applyTheme();

// ---------- render ----------

function render() {
  if (!state.catalog) return;
  const route = currentRoute();
  const prev = state.view;
  state.view = route.view;
  const reading = route.view === "read";
  document.body.classList.toggle("reading", reading);
  els.reader.hidden = !reading;

  if (reading) {
    if (prev !== "read") {
      state.enteredReaderFromLibrary = prev !== null;
      state.returnTo = state.libraryHash;
    }
    renderReader(route);
  } else {
    state.libraryHash = location.hash || "#/";
    renderSidebar(route);
    renderLibrary(route);
    if (prev === "read") requestAnimationFrame(() => document.activeElement?.blur?.());
  }
}

// Repository page: set by the build (meta.toml / git remote); on <user>.github.io/<repo>/ it can also be inferred.
function repoLink() {
  if (state.catalog.library.repo) return state.catalog.library.repo;
  const m = /^([^.]+)\.github\.io$/.exec(location.hostname);
  const name = location.pathname.split("/").filter(Boolean)[0];
  return m && name ? `https://github.com/${m[1]}/${name}` : "";
}

function renderFooter() {
  const { docs, generated } = state.catalog;
  const total = docs.reduce((n, d) => n + d.size, 0);
  const pages = docs.reduce((n, d) => n + (d.pages || 0), 0);
  const parts = [plural(docs.length, "document"), plural(pages, "page"), formatBytes(total)];
  if (state.folders.length) parts.splice(1, 0, plural(state.folders.length, "category", "categories"));
  if (generated) parts.push(`updated ${formatDate(generated)}`);
  const children = [parts.join(" · ")];
  const repo = repoLink();
  if (repo) children.push(" · ", el("a", { href: repo, target: "_blank", rel: "noopener" }, "Source on GitHub"));
  els.footer.replaceChildren(...children);
}

// Favorites and progress saved by the first version used path-based ids; move them to the new ids.
function migrateStoredIds() {
  const upgrade = (id) => (state.byId.has(id) ? id : state.legacy.get(id));
  const favs = [...state.favorites].map(upgrade).filter(Boolean);
  if (favs.length !== state.favorites.size || favs.some((id) => !state.favorites.has(id))) {
    state.favorites = new Set(favs);
    save.favorites();
  }
  let changed = false;
  for (const [id, r] of Object.entries(state.recent)) {
    const to = upgrade(id);
    if (to === id) continue;
    delete state.recent[id];
    if (to && (!state.recent[to] || state.recent[to].at < r.at)) state.recent[to] = r;
    changed = true;
  }
  if (changed) save.recent();
}

async function boot() {
  try {
    const res = await fetch("data/catalog.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.catalog = await res.json();
  } catch (e) {
    els.layoutRoot.hidden = false;
    els.sidebar.hidden = true;
    showEmpty("Couldn't load the library", el("p", {}, `data/catalog.json failed to load (${e.message}). Run `, el("code", {}, "npm run build"), " first."));
    return;
  }
  const c = state.catalog;
  c.library ??= { title: "BookReader", description: "" };
  state.docs = (c.docs || []).map((d) => ({ authors: [], tags: [], folder: "", folderTitle: "", ...d }));
  state.byId = new Map(state.docs.map((d) => [d.id, d]));
  state.legacy = new Map(state.docs.filter((d) => d.legacy).map((d) => [d.legacy, d.id]));
  state.folders = c.folders || [];
  state.folderByPath = new Map(state.folders.map((f) => [f.path, f]));
  for (const d of state.docs) for (const p of ancestors(d.folder)) state.folderCount.set(p, (state.folderCount.get(p) || 0) + 1);

  migrateStoredIds();
  $("#brand-title").textContent = c.library.title;
  const repo = repoLink();
  if (repo) {
    $("#repo").href = repo;
    $("#repo").hidden = false;
  }
  els.layoutRoot.hidden = false;
  renderFooter();
  render();
}

boot();
