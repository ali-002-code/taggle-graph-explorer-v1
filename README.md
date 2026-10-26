# Taggle Graph Explorer V1

Interactive explorer for TAGGLE_MASTER_GRAPH_V1 — the merged, deduplicated
restaurant co-review network. Restaurant &harr; restaurant graph only.

No real reviewer identity is exposed anywhere in this app: every reviewer
appears only as a sequential anonymous number ("Reviewer 1742"), never a
name, Google contributor ID, or profile URL. Restaurant names/categories/
addresses are public business information and remain visible.

Published as a static site — no build step, no npm, no server-side code.
All data under `data/` is a frozen snapshot generated from the canonical
TAGGLE_MASTER_GRAPH_V1 build at publish time.

## Run it locally

```bash
cd taggle-graph-explorer-v1
python3 -m http.server 8080
# open http://localhost:8080
```

## Regenerating the data (source repo only)

This repo is a publish target — the data pipeline lives in the main Taggle
repo, not here. To refresh `data/` from a new master-graph build:

```bash
cd pipeline && source .venv/bin/activate
python3 scripts/build_explorer_v1_data.py
python3 -m pytest tests/test_build_explorer_v1_data.py
```

then copy `pipeline/processed/taggle_master_graph_v1/explorer/{restaurants,graph_summary,restaurant_neighbours,interactions_anon,restaurant_edges}.json`
into this repo's `data/` and push.

## Files

- `index.html` / `styles.css` / `app.js` — the app.
- `data/` — frozen data snapshot (restaurants, derived neighbour lists,
  anonymised reviewer interactions, default edge set, graph summary).
