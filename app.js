/* Taggle Graph Explorer V1 — local dev build.
 *
 * Source of truth: processed/taggle_master_graph_v1/explorer/*.json
 * (TAGGLE_MASTER_GRAPH_V1, read-only). This file never guesses graph
 * structure — every number shown comes from those JSON artifacts, which are
 * themselves derived from (and tested against) the canonical master graph.
 *
 * Node size metric  : degree_ge2  ("Network connectivity")
 * Edge thickness    : shared_reviewer count (the edge weight), linear + capped
 * Bridge ranking     : weighted_shared_reviewer_degree
 * Everything here is STRUCTURAL (co-review density) — never a taste,
 * quality, or recommendation signal.
 */

const DATA_BASE = "data/";
const DISPLAY_LIMIT = 20;      // neighbours shown on initial focus
const EXPAND_CAP = 100;        // max nodes visible at once (excl. focus accounting included)
const HISTORY_CAP = 30;

const state = {
  restaurants: [],         // array, index parity with backend-assigned idx
  idToIdx: new Map(),
  neighbours: null,        // lazy: { "<idx>": [[nidx, weight], ...] }
  anon: null,              // lazy: { n_restaurants, n_reviewers, rows: [[ridx, revAnon, rating], ...] }
  reviewersByRestaurant: null,   // lazy built: Map(restaurantIdx -> Map(revAnon -> rating))
  restaurantsByReviewer: null,   // lazy built: Map(revAnon -> [[restaurantIdx, rating], ...])
  graphSummary: null,
  threshold: 2,
  focusIdx: null,
  visibleIdx: new Set(),
  historyStack: [],
  cy: null,
  selectedEdge: null,      // { a, b, weight }
  communityMembers: null,  // lazy built: Map(communityId -> [idx,...])
};

// ---------------------------------------------------------------------
// data loading
// ---------------------------------------------------------------------

async function fetchJSON(name) {
  const res = await fetch(DATA_BASE + name);
  if (!res.ok) throw new Error(`failed to load ${name}: ${res.status}`);
  return res.json();
}

async function loadNeighbours() {
  if (!state.neighbours) state.neighbours = await fetchJSON("restaurant_neighbours.json");
  return state.neighbours;
}

async function loadAnon() {
  if (!state.anon) {
    state.anon = await fetchJSON("interactions_anon.json");
    state.reviewersByRestaurant = new Map();
    state.restaurantsByReviewer = new Map();
    for (const [ridx, revAnon, rating] of state.anon.rows) {
      if (!state.reviewersByRestaurant.has(ridx)) state.reviewersByRestaurant.set(ridx, new Map());
      state.reviewersByRestaurant.get(ridx).set(revAnon, rating);
      if (!state.restaurantsByReviewer.has(revAnon)) state.restaurantsByReviewer.set(revAnon, []);
      state.restaurantsByReviewer.get(revAnon).push([ridx, rating]);
    }
  }
  return state.anon;
}

async function loadEdgesTeaser() {
  return fetchJSON("restaurant_edges.json");
}

async function init() {
  const [restaurants, graphSummary] = await Promise.all([
    fetchJSON("restaurants.json"),
    fetchJSON("graph_summary.json"),
  ]);
  state.restaurants = restaurants;
  state.graphSummary = graphSummary;
  restaurants.forEach((r, idx) => state.idToIdx.set(r.id, idx));

  renderGraphSummaryBar();
  renderHomeTeaser();
  initCytoscape();
  wireControls();
  showHome();
}

// ---------------------------------------------------------------------
// derived (client-side) structural metrics
// ---------------------------------------------------------------------

function jaccardAndOverlap(a, b, weight) {
  const nA = a.n_reviewers, nB = b.n_reviewers;
  const union = nA + nB - weight;
  const jaccard = union > 0 ? weight / union : 0;
  const overlap = Math.min(nA, nB) > 0 ? weight / Math.min(nA, nB) : 0;
  return { jaccard, overlap };
}

function densestRanking(limit = 20) {
  return [...state.restaurants]
    .sort((a, b) => (b.degree_ge2 - a.degree_ge2) || (b.weighted_shared_reviewer_degree - a.weighted_shared_reviewer_degree))
    .slice(0, limit);
}

function bridgeRanking(limit = 20) {
  return [...state.restaurants]
    .sort((a, b) => b.weighted_shared_reviewer_degree - a.weighted_shared_reviewer_degree)
    .slice(0, limit);
}

function buildCommunityMembers() {
  if (state.communityMembers) return state.communityMembers;
  const map = new Map();
  state.restaurants.forEach((r, idx) => {
    if (r.community_id === null || r.community_id === undefined) return;
    if (!map.has(r.community_id)) map.set(r.community_id, []);
    map.get(r.community_id).push(idx);
  });
  state.communityMembers = map;
  return map;
}

function communityRanking() {
  const members = buildCommunityMembers();
  return [...members.entries()]
    .map(([cid, idxs]) => ({ cid, size: idxs.length, idxs }))
    .sort((a, b) => b.size - a.size);
}

// ---------------------------------------------------------------------
// local subgraph construction
// ---------------------------------------------------------------------

function neighboursFor(idx, threshold) {
  const lst = state.neighbours[String(idx)] || [];
  return lst.filter(([, w]) => w >= threshold);
}

async function buildFocusSubgraph(centerIdx, threshold) {
  await loadNeighbours();
  const neigh = neighboursFor(centerIdx, threshold).slice(0, DISPLAY_LIMIT);
  const nodeSet = new Set([centerIdx, ...neigh.map(([nidx]) => nidx)]);
  const edges = neigh.map(([nidx, w]) => ({ a: centerIdx, b: nidx, w }));
  return { nodeSet, edges, truncated: neighboursFor(centerIdx, threshold).length > DISPLAY_LIMIT };
}

async function expandCurrentSubgraph() {
  await loadNeighbours();
  const currentNodes = [...state.visibleIdx];
  const edgeKey = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const edgeMap = new Map();

  // keep existing edges
  state.cy.edges().forEach((e) => {
    const a = Number(e.data("a")), b = Number(e.data("b")), w = Number(e.data("weight"));
    edgeMap.set(edgeKey(a, b), { a, b, w });
  });

  for (const nidx of currentNodes) {
    for (const [nnidx, w] of neighboursFor(nidx, state.threshold)) {
      const key = edgeKey(nidx, nnidx);
      if (!edgeMap.has(key) || edgeMap.get(key).w < w) edgeMap.set(key, { a: nidx, b: nnidx, w });
    }
  }

  const nodeWeight = new Map(); // idx -> strongest incident weight (for ranking which to keep)
  for (const { a, b, w } of edgeMap.values()) {
    nodeWeight.set(a, Math.max(nodeWeight.get(a) || 0, w));
    nodeWeight.set(b, Math.max(nodeWeight.get(b) || 0, w));
  }
  nodeWeight.set(state.focusIdx, Infinity); // focus always kept

  let nodeSet = new Set([...currentNodes, ...[...edgeMap.values()].flatMap((e) => [e.a, e.b])]);
  let truncated = false;
  if (nodeSet.size > EXPAND_CAP) {
    truncated = true;
    const ranked = [...nodeSet].sort((x, y) => (nodeWeight.get(y) || 0) - (nodeWeight.get(x) || 0));
    nodeSet = new Set(ranked.slice(0, EXPAND_CAP));
  }

  const edges = [...edgeMap.values()].filter((e) => nodeSet.has(e.a) && nodeSet.has(e.b));
  return { nodeSet, edges, truncated };
}

// ---------------------------------------------------------------------
// cytoscape rendering
// ---------------------------------------------------------------------

function nodeSizePx(degreeGe2) {
  const v = Math.sqrt(Math.min(degreeGe2, 120) + 1);
  return 16 + v * 5.2; // ~16px for degree 0, ~70px for a 200+ degree hub
}

function edgeWidthPx(weight) {
  return Math.min(1 + weight * 0.6, 14);
}

function initCytoscape() {
  state.cy = cytoscape({
    container: document.getElementById("cy"),
    style: [
      {
        selector: "node",
        style: {
          "background-color": "#5b8def",
          "label": "data(label)",
          "color": "#e7e9ee",
          "font-size": 10,
          "text-valign": "bottom",
          "text-margin-y": 4,
          "width": "data(size)",
          "height": "data(size)",
          "border-width": 0,
        },
      },
      { selector: "node[?isFocus]", style: { "background-color": "#39b37e", "border-width": 3, "border-color": "#9be8c7" } },
      { selector: "node[?isBridge]", style: { "border-width": 3, "border-color": "#e0a23a" } },
      {
        selector: "node[community]",
        style: { "background-color": "data(communityColor)" },
      },
      {
        selector: "edge",
        style: {
          "width": "data(width)",
          "line-color": "#3a4150",
          "curve-style": "haystack",
          "opacity": 0.85,
        },
      },
      { selector: "edge:selected", style: { "line-color": "#5b8def", "opacity": 1 } },
      { selector: "node:selected", style: { "border-width": 3, "border-color": "#5b8def" } },
    ],
    layout: { name: "concentric", animate: false },
    wheelSensitivity: 0.25,
  });

  state.cy.on("tap", "node", (evt) => {
    const idx = Number(evt.target.id());
    if (idx === state.focusIdx) {
      showRestaurantDetail(idx);
    } else {
      focusRestaurant(idx);
    }
  });

  state.cy.on("tap", "edge", (evt) => {
    const a = Number(evt.target.data("a"));
    const b = Number(evt.target.data("b"));
    const w = Number(evt.target.data("weight"));
    showEdgeDetail(a, b, w);
  });
}

const COMMUNITY_PALETTE = ["#5b8def", "#39b37e", "#e0a23a", "#c9699e", "#5bc0de", "#9b8fe0", "#e2683c", "#7fd1b9"];

function renderSubgraph({ nodeSet, edges }, { highlightCommunity = false } = {}) {
  document.getElementById("homeScreen").classList.add("hidden");
  document.getElementById("cy").classList.remove("hidden");
  document.getElementById("graphControls").classList.remove("hidden");
  document.getElementById("thresholdBox").classList.remove("hidden");

  state.visibleIdx = nodeSet;

  const elements = [];
  for (const idx of nodeSet) {
    const r = state.restaurants[idx];
    const data = {
      id: String(idx),
      label: r.title,
      size: nodeSizePx(r.degree_ge2),
      isFocus: idx === state.focusIdx,
      isBridge: r.is_articulation_bridge,
    };
    if (highlightCommunity && r.community_id !== null && r.community_id !== undefined) {
      data.community = r.community_id;
      data.communityColor = COMMUNITY_PALETTE[r.community_id % COMMUNITY_PALETTE.length];
    }
    elements.push({ group: "nodes", data });
  }
  for (const { a, b, w } of edges) {
    elements.push({
      group: "edges",
      data: { id: `e${a}_${b}`, source: String(a), target: String(b), a, b, weight: w, width: edgeWidthPx(w) },
    });
  }

  state.cy.elements().remove();
  state.cy.add(elements);
  state.cy.layout({
    name: "cose",
    animate: false,
    fit: true,
    padding: 60,
    nodeRepulsion: () => 12000,
    idealEdgeLength: () => 90,
  }).run();
  state.cy.fit(undefined, 60);
}

function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._hideTimer);
  t._hideTimer = setTimeout(() => t.classList.add("hidden"), 4000);
}

// ---------------------------------------------------------------------
// focus / history / expand / reset
// ---------------------------------------------------------------------

function pushHistory() {
  if (state.focusIdx === null) return;
  state.historyStack.push({ focusIdx: state.focusIdx, threshold: state.threshold, visibleIdx: new Set(state.visibleIdx) });
  if (state.historyStack.length > HISTORY_CAP) state.historyStack.shift();
}

async function focusRestaurant(idx, { fromHistory = false } = {}) {
  if (!fromHistory) pushHistory();
  state.focusIdx = idx;
  const { nodeSet, edges, truncated } = await buildFocusSubgraph(idx, state.threshold);
  renderSubgraph({ nodeSet, edges });
  showRestaurantDetail(idx);
  if (truncated) showToast(`Showing the ${DISPLAY_LIMIT} strongest connections — weaker ones are hidden.`);
}

async function expandNeighbours() {
  if (state.focusIdx === null) return;
  pushHistory();
  const { nodeSet, edges, truncated } = await expandCurrentSubgraph();
  renderSubgraph({ nodeSet, edges });
  if (truncated) showToast(`Capped at ${EXPAND_CAP} restaurants — lower-weight connections are hidden.`);
}

function goBack() {
  const prev = state.historyStack.pop();
  if (!prev) { showHome(); return; }
  state.focusIdx = prev.focusIdx;
  state.threshold = prev.threshold;
  syncThresholdButtons();
  const edges = [];
  const edgeKey = new Set();
  for (const idx of prev.visibleIdx) {
    for (const [nidx, w] of neighboursFor(idx, state.threshold)) {
      if (!prev.visibleIdx.has(nidx)) continue;
      const key = idx < nidx ? `${idx}_${nidx}` : `${nidx}_${idx}`;
      if (edgeKey.has(key)) continue;
      edgeKey.add(key);
      edges.push({ a: idx, b: nidx, w });
    }
  }
  renderSubgraph({ nodeSet: prev.visibleIdx, edges });
  showRestaurantDetail(state.focusIdx);
}

function showHome() {
  state.focusIdx = null;
  state.visibleIdx = new Set();
  state.historyStack = [];
  document.getElementById("homeScreen").classList.remove("hidden");
  document.getElementById("cy").classList.add("hidden");
  document.getElementById("graphControls").classList.add("hidden");
  document.getElementById("thresholdBox").classList.add("hidden");
  if (state.cy) state.cy.elements().remove();
  showDetailEmpty();
  document.getElementById("sidebarList").innerHTML = "";
}

// ---------------------------------------------------------------------
// search
// ---------------------------------------------------------------------

function searchRestaurants(query, limit = 10) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored = [];
  for (let idx = 0; idx < state.restaurants.length; idx++) {
    const r = state.restaurants[idx];
    const title = r.title.toLowerCase();
    const pos = title.indexOf(q);
    if (pos === -1) continue;
    const score = (pos === 0 ? 0 : 1) * 100000 - r.degree_ge2;
    scored.push({ idx, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((s) => s.idx);
}

function wireSearch() {
  const input = document.getElementById("searchInput");
  const resultsEl = document.getElementById("searchResults");
  input.addEventListener("input", () => {
    const idxs = searchRestaurants(input.value);
    if (idxs.length === 0) { resultsEl.classList.add("hidden"); resultsEl.innerHTML = ""; return; }
    resultsEl.innerHTML = "";
    for (const idx of idxs) {
      const r = state.restaurants[idx];
      const row = document.createElement("div");
      row.className = "result-row";
      row.innerHTML = `<span class="result-title">${escapeHtml(r.title)}</span><span class="result-sub">${escapeHtml(r.category || "")}</span>`;
      row.addEventListener("click", () => {
        resultsEl.classList.add("hidden");
        input.value = r.title;
        focusRestaurant(idx);
      });
      resultsEl.appendChild(row);
    }
    resultsEl.classList.remove("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!document.getElementById("searchBox").contains(e.target)) resultsEl.classList.add("hidden");
  });
}

// ---------------------------------------------------------------------
// quick-action lists (densest / bridges / communities)
// ---------------------------------------------------------------------

function renderRankedList(title, explain, items, labelFn) {
  const el = document.getElementById("sidebarList");
  el.innerHTML = `<div class="list-header">${title}</div><div class="list-explain">${explain}</div>`;
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "list-row";
    const { primary, secondary, idx } = labelFn(item);
    row.innerHTML = `<span class="list-title">${escapeHtml(primary)}</span><span class="list-sub">${escapeHtml(secondary)}</span>`;
    row.addEventListener("click", () => focusRestaurant(idx));
    el.appendChild(row);
  }
}

function showDensest() {
  renderRankedList(
    "Densest restaurants",
    "Ranked by network connectivity — the number of other restaurants sharing at least 2 reviewers.",
    densestRanking(20),
    (r) => ({ primary: r.title, secondary: `${r.degree_ge2}`, idx: state.idToIdx.get(r.id) })
  );
}

function showBridges() {
  renderRankedList(
    "Bridge restaurants",
    "Bridge restaurants connect otherwise separate parts of the restaurant network.",
    bridgeRanking(20),
    (r) => ({ primary: r.title, secondary: `${r.weighted_shared_reviewer_degree}`, idx: state.idToIdx.get(r.id) })
  );
}

function showCommunities() {
  const ranking = communityRanking();
  const el = document.getElementById("sidebarList");
  el.innerHTML = `<div class="list-header">Structural communities</div><div class="list-explain">Groups of restaurants that tend to be reviewed by the same people. Structural only — not a taste match.</div>`;
  for (const c of ranking) {
    const row = document.createElement("div");
    row.className = "list-row";
    row.innerHTML = `<span class="list-title">Community ${c.cid}</span><span class="list-sub">${c.size} restaurants</span>`;
    row.addEventListener("click", () => openCommunity(c));
    el.appendChild(row);
  }
}

async function openCommunity(community) {
  await loadNeighbours();
  const topMembers = community.idxs
    .map((idx) => state.restaurants[idx])
    .map((r, i) => ({ r, idx: community.idxs[i] }))
    .sort((a, b) => b.r.degree_ge2 - a.r.degree_ge2)
    .slice(0, 25);
  const topIdxSet = new Set(topMembers.map((m) => m.idx));

  const edges = [];
  const seen = new Set();
  for (const { idx } of topMembers) {
    for (const [nidx, w] of neighboursFor(idx, state.threshold)) {
      if (!topIdxSet.has(nidx)) continue;
      const key = idx < nidx ? `${idx}_${nidx}` : `${nidx}_${idx}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ a: idx, b: nidx, w });
    }
  }

  state.focusIdx = topMembers[0].idx;
  renderSubgraph({ nodeSet: topIdxSet, edges }, { highlightCommunity: true });
  document.getElementById("sidebarList").innerHTML =
    `<div class="list-header">Community ${community.cid}</div><div class="list-explain">${community.size} restaurants total — showing the ${topMembers.length} most-connected. Click any node to focus it.</div>`;
  showDetailEmpty(`Community ${community.cid} &middot; ${community.size} restaurants (structural, not taste-based)`);
}

// ---------------------------------------------------------------------
// detail panel: restaurant
// ---------------------------------------------------------------------

function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function showDetailEmpty(msg) {
  document.getElementById("detailEmpty").innerHTML = msg || "Select a restaurant or a connection to see details.";
  document.getElementById("detailEmpty").classList.remove("hidden");
  document.getElementById("detailContent").classList.add("hidden");
}

function degreeAtThreshold(r, t) {
  if (t <= 1) return r.degree_ge1;
  if (t === 2) return r.degree_ge2;
  if (t === 3) return r.degree_ge3;
  return r.degree_ge5;
}

function showRestaurantDetail(idx) {
  const r = state.restaurants[idx];
  const content = document.getElementById("detailContent");
  document.getElementById("detailEmpty").classList.add("hidden");
  content.classList.remove("hidden");

  const degree = degreeAtThreshold(r, state.threshold);
  let html = `
    <h3>${escapeHtml(r.title)}</h3>
    <div class="category-badge">${escapeHtml(r.category || "Uncategorized")}</div>
    <div class="summary-line">Connected to <strong>${degree}</strong> restaurants through at least ${state.threshold} shared reviewer${state.threshold === 1 ? "" : "s"}.</div>
    <div class="summary-line">${r.n_reviewers} reviewer${r.n_reviewers === 1 ? "" : "s"} have reviewed this restaurant on Google.</div>
    ${r.address ? `<div class="summary-line muted">${escapeHtml(r.address)}</div>` : ""}
  `;
  if (r.is_articulation_bridge) {
    html += `<div class="callout">This restaurant is a bridge — it connects otherwise separate parts of the network.</div>`;
  }
  if (r.community_id !== null && r.community_id !== undefined) {
    const size = buildCommunityMembers().get(r.community_id).length;
    html += `<div class="callout community">Part of structural community ${r.community_id} (${size} restaurants).</div>`;
  }
  html += `
    <details class="tech">
      <summary>Technical details</summary>
      <table>
        <tr><td>Entity ID</td><td class="val">${escapeHtml(r.id)}</td></tr>
        <tr><td>Degree (&ge;1)</td><td class="val">${r.degree_ge1}</td></tr>
        <tr><td>Degree (&ge;2)</td><td class="val">${r.degree_ge2}</td></tr>
        <tr><td>Degree (&ge;3)</td><td class="val">${r.degree_ge3}</td></tr>
        <tr><td>Degree (&ge;5)</td><td class="val">${r.degree_ge5}</td></tr>
        <tr><td>Weighted shared-reviewer degree</td><td class="val">${r.weighted_shared_reviewer_degree}</td></tr>
        <tr><td>Local clustering coefficient</td><td class="val">${r.local_clustering_coefficient ?? "—"}</td></tr>
        <tr><td>Component ID (&ge;1 graph)</td><td class="val">${r.component_id}</td></tr>
        <tr><td>Structural community (&ge;2 graph)</td><td class="val">${r.community_id ?? "—"}</td></tr>
        <tr><td>Articulation bridge</td><td class="val">${r.is_articulation_bridge}</td></tr>
      </table>
    </details>
  `;
  content.innerHTML = html;
}

// ---------------------------------------------------------------------
// detail panel: edge + shared reviewers + reviewer drilldown
// ---------------------------------------------------------------------

function showEdgeDetail(a, b, weight) {
  state.selectedEdge = { a, b, weight };
  const ra = state.restaurants[a], rb = state.restaurants[b];
  const { jaccard, overlap } = jaccardAndOverlap(ra, rb, weight);
  const content = document.getElementById("detailContent");
  document.getElementById("detailEmpty").classList.add("hidden");
  content.classList.remove("hidden");
  content.innerHTML = `
    <div class="edge-row"><span class="node">${escapeHtml(ra.title)}</span><span class="edge-arrow">&harr;</span><span class="node">${escapeHtml(rb.title)}</span></div>
    <div class="summary-line" style="text-align:center">${weight} reviewer${weight === 1 ? "" : "s"} have reviewed both restaurants.</div>
    <details class="tech" open>
      <summary>Technical details</summary>
      <table>
        <tr><td>Shared reviewers</td><td class="val">${weight}</td></tr>
        <tr><td>Jaccard overlap</td><td class="val">${jaccard.toFixed(4)}</td></tr>
        <tr><td>Overlap coefficient</td><td class="val">${overlap.toFixed(4)}</td></tr>
      </table>
    </details>
    <button class="link-btn" id="showSharedBtn">Show shared reviewers</button>
    <div id="sharedReviewersList"></div>
  `;
  document.getElementById("showSharedBtn").addEventListener("click", () => renderSharedReviewers(a, b));
}

async function renderSharedReviewers(a, b) {
  await loadAnon();
  const byA = state.reviewersByRestaurant.get(a) || new Map();
  const byB = state.reviewersByRestaurant.get(b) || new Map();
  const shared = [...byA.keys()].filter((rev) => byB.has(rev));

  const container = document.getElementById("sharedReviewersList");
  if (shared.length === 0) {
    container.innerHTML = `<div class="muted" style="margin-top:8px">No shared reviewers found.</div>`;
    return;
  }
  let html = `<div class="section-label" style="margin-top:12px">Shared reviewers (${shared.length})</div>`;
  for (const rev of shared) {
    const ratingA = byA.get(rev);
    const ratingB = byB.get(rev);
    html += `<div class="shared-reviewer-row" data-rev="${rev}">
      <span>Reviewer ${rev}</span>
      <span>A: ${ratingA ?? "—"} &middot; B: ${ratingB ?? "—"}</span>
    </div>`;
  }
  container.innerHTML = html;
  container.querySelectorAll(".shared-reviewer-row").forEach((row) => {
    row.addEventListener("click", () => showReviewerHistory(Number(row.dataset.rev)));
  });
}

function showReviewerHistory(revAnon) {
  const history = state.restaurantsByReviewer.get(revAnon) || [];
  const content = document.getElementById("detailContent");
  let html = `<h3>Reviewer ${revAnon}</h3><div class="summary-line">Strict restaurant history — ${history.length} restaurant${history.length === 1 ? "" : "s"} reviewed.</div>`;
  for (const [idx, rating] of history.sort((x, y) => (y[1] || 0) - (x[1] || 0))) {
    const r = state.restaurants[idx];
    html += `<div class="history-row">
      <div class="h-title">${escapeHtml(r.title)} ${rating !== null ? `&middot; ${rating}&#9733;` : ""}</div>
      <div class="h-meta">${escapeHtml(r.category || "")}${r.address ? " &middot; " + escapeHtml(r.address) : ""}</div>
    </div>`;
  }
  html += `<button class="link-btn" id="backToEdgeBtn">Back</button>`;
  content.innerHTML = html;
  document.getElementById("backToEdgeBtn").addEventListener("click", () => {
    if (state.selectedEdge) showEdgeDetail(state.selectedEdge.a, state.selectedEdge.b, state.selectedEdge.weight);
  });
}

// ---------------------------------------------------------------------
// home teaser + graph summary bar
// ---------------------------------------------------------------------

function largestComponent(edgeList) {
  // Picking "top N edges by weight" can include a few edges whose nodes
  // never touch the main cluster, which renders as a stray floating
  // island. Keep only the largest connected component so the teaser
  // always reads as one coherent network.
  const adj = new Map();
  const addEdge = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b);
    adj.get(b).add(a);
  };
  edgeList.forEach((e) => addEdge(e.source, e.target));

  const seen = new Set();
  let best = new Set();
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const comp = new Set([start]);
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const cur = stack.pop();
      for (const n of adj.get(cur)) {
        if (!seen.has(n)) { seen.add(n); comp.add(n); stack.push(n); }
      }
    }
    if (comp.size > best.size) best = comp;
  }
  return {
    nodeIds: best,
    edges: edgeList.filter((e) => best.has(e.source) && best.has(e.target)),
  };
}

async function renderHomeTeaser() {
  try {
    const edges = await loadEdgesTeaser();
    const candidate = edges.slice().sort((e1, e2) => e2.weight - e1.weight).slice(0, 70);
    const { nodeIds, edges: top } = largestComponent(candidate);

    // only label the most-connected handful so the preview stays legible
    // rather than a wall of overlapping micro-text
    const byDegree = [...nodeIds]
      .map((id) => state.restaurants[state.idToIdx.get(id)])
      .sort((a, b) => b.degree_ge2 - a.degree_ge2);
    const labelled = new Set(byDegree.slice(0, 10).map((r) => r.id));

    const container = document.getElementById("homeTeaser");
    const teaserCy = cytoscape({
      container,
      elements: [
        ...[...nodeIds].map((id) => {
          const idx = state.idToIdx.get(id);
          const r = state.restaurants[idx];
          const communityId = r.community_id;
          return {
            group: "nodes",
            data: {
              id,
              label: labelled.has(id) ? r.title : "",
              size: Math.max(nodeSizePx(r.degree_ge2), 22),
              color: communityId !== null && communityId !== undefined
                ? COMMUNITY_PALETTE[communityId % COMMUNITY_PALETTE.length]
                : "#5b8def",
            },
          };
        }),
        ...top.map((e) => ({ group: "edges", data: { id: `${e.source}_${e.target}`, source: e.source, target: e.target, width: edgeWidthPx(e.weight) } })),
      ],
      style: [
        {
          selector: "node",
          style: {
            "background-color": "data(color)",
            "label": "data(label)",
            "color": "#e7e9ee",
            "font-size": 13,
            "font-weight": 600,
            "text-valign": "bottom",
            "text-margin-y": 6,
            "text-outline-width": 2,
            "text-outline-color": "#0f1115",
            "width": "data(size)",
            "height": "data(size)",
          },
        },
        { selector: "node:active", style: { "overlay-opacity": 0.15 } },
        { selector: "edge", style: { "width": "data(width)", "line-color": "#454d5c", "curve-style": "haystack", "opacity": 0.8 } },
      ],
      layout: { name: "cose", animate: false, padding: 50, nodeRepulsion: () => 18000, idealEdgeLength: () => 70 },
      userZoomingEnabled: false,
      userPanningEnabled: false,
      boxSelectionEnabled: false,
      autoungrabify: true,
    });
    teaserCy.fit(undefined, 40);
    teaserCy.on("mouseover", "node", (evt) => { container.style.cursor = "pointer"; });
    teaserCy.on("mouseout", "node", (evt) => { container.style.cursor = "default"; });
    teaserCy.on("tap", "node", (evt) => focusRestaurant(state.idToIdx.get(evt.target.id())));
  } catch (e) {
    // teaser is optional/decorative — never block the app on it
    console.warn("home teaser failed to load", e);
  }
}

function renderGraphSummaryBar() {
  const t = state.graphSummary.canonical_totals;
  document.getElementById("graphSummaryBar").textContent =
    `TAGGLE MASTER GRAPH — ${t.final_unique_restaurants.toLocaleString()} restaurants · ${t.final_unique_reviewers.toLocaleString()} reviewers · ${t.final_unique_edges.toLocaleString()} reviewer–restaurant connections`;
}

// ---------------------------------------------------------------------
// controls wiring
// ---------------------------------------------------------------------

function syncThresholdButtons() {
  document.querySelectorAll(".threshold-btn").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.threshold) === state.threshold);
  });
}

function wireControls() {
  wireSearch();

  document.querySelectorAll(".action-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      if (action === "densest") showDensest();
      else if (action === "bridges") showBridges();
      else if (action === "communities") showCommunities();
      else if (action === "reset") showHome();
    });
  });

  document.querySelectorAll(".threshold-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      state.threshold = Number(btn.dataset.threshold);
      syncThresholdButtons();
      if (state.focusIdx !== null) {
        pushHistory();
        const { nodeSet, edges, truncated } = await buildFocusSubgraph(state.focusIdx, state.threshold);
        renderSubgraph({ nodeSet, edges });
        showRestaurantDetail(state.focusIdx);
        if (truncated) showToast(`Showing the ${DISPLAY_LIMIT} strongest connections at this threshold.`);
      }
    });
  });

  document.getElementById("expandBtn").addEventListener("click", expandNeighbours);
  document.getElementById("backBtn").addEventListener("click", goBack);
}

init();
