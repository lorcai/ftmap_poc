# Engineering notes — `ftmap_poc`

Operational and design context for whoever maintains the static Faerun + MSA HUD demos. **Skim the bold bullets first;** the rest is detail you need when touching Nightingale or the HUD.

---

## What this PoC is

- **Static export** of Faerun (Lore) scatter plots plus a fixed-position **MSA HUD**: BioWasm **Aioli** (samtools faidx + kalign) and optional **EBI Nightingale** (`nightingale-manager` + `nightingale-navigation` + `nightingale-msa`) for alignment display.
- **No app bundler** in-repo: pages load scripts via `<script>` / `import` URLs. Nightingale is loaded from **`esm.sh`** at pinned **`@nightingale-elements/*@5.6.0`** (see `assets/tmap_silva_freqs.html` tail).
- **Primary integration code:** `js/msa_hud_module.js` (HUD logic + Nightingale glue), `js/bridge.js` (plot selection → FASTA ids), per-page `window.TMAP_MSA` overrides in HTML.

---

## Nightingale: CDN vs local `nightingale/`

- **The running app uses the CDN build only.** A **`nightingale/`** directory may exist as a **read-only clone for API / source reference**; it is **not** wired into the static pages. Do **not** edit it for PoC fixes (see parent repo `.cursor/rules/no-edit-sourced-components.mdc`).
- If you later **bundle**, install the **same published packages and versions** as the CDN imports and bundle from `node_modules` — not an edited vendor tree — unless you deliberately fork.

---

## MSA HUD data flow

**Essential product feature:** users can **paste a list of sequence ids** into staging (or build it via **Sync from plot**) and click **Highlight on plot** so the Faerun view selects every matching point—then **Run kalign** on that same list without re-picking points by hand. Treat this workflow as a first-class requirement when changing the HUD or regenerating assets.

1. User selects points on the Faerun plot → `bridge.js` exposes `getSelectedSequenceIds()` (uses `data[...].labels`; optional `window.tmapPlotLabelToSeqId` when the label is not the FASTA id, e.g. Ty1).
2. **Sync** appends ids to the shared **staging** textarea (deduped, caps via `TMAP_MSA.maxStaging`). **Highlight on plot** reads staging and drives Lore `OctreeHelper.addSelected` with the same label→id mapping as Sync (`highlightTmapPlotFromSequenceIds` / `clearTmapPlotSelection` in `msa_hud_module.js`). `bridge.js` only implements `getSelectedSequenceIds` for Sync.
3. **Run kalign** loads sequences (`TMAP_MSA.bgzfUrl` + indexed `.gz` / `.fai` / `.gzi`, or `referenceBase` under `fixtures/`, or `fastaUrl` for small plain FASTA), runs kalign, shows text in `#tmap-msa-out`, pushes alignment into Nightingale via `updateNightingaleMsaFromFasta`.

**kalign stdout:** Only **stdout** is safe to treat as FASTA (`execToString`); stderr must not be concatenated into kalign input.

---

## `window.TMAP_MSA` contract (defaults + overrides)

Defined in `msa_hud_module.js` and **merged** with page-specific `Object.assign` in HTML. Important keys:

| Key | Role |
|-----|------|
| `referenceBase` | Filename under `fixtures/` (e.g. Ty1 subset `.fa.gz`) when not using `bgzfUrl`. |
| `bgzfUrl` | Optional absolute/relative URL to BGZF + sidecar indexes (from `?bgzf=` pattern). |
| `fastaUrl` | Plain FASTA path when not using indexed gzip (kalign-only Aioli path). |
| `fixturesRel` | Prefix for fixture URLs (default `../fixtures`). |
| `maxAlign` / `maxStaging` / `faidxBatch` | Demo limits. |
| `msaColorScheme` | Nightingale color scheme (SILVA/Ty1 use `nucleotide`). |
| `msaInitialVisibleColumns` | **SILVA only (typ.120):** if alignment length exceeds this, initial `display-end` is this value so the first view is a readable window, not the full long amplicon strip. |

---

## Nightingale integration — decisions and pitfalls

These are **intentional**; regressing them brings back “blank MSA”, “zoom/pan dead”, or “navigator shows 1–1”.

1. **Unhide before `data`**  
   `#tmap-msa-viewer-wrap` stays `hidden` until there is alignment data. The code sets `wrap.hidden = false` **before** assigning `el.data` so layout width/height are non-zero (hidden subtrees often measure as zero).

2. **FASTA → Nightingale rows**  
   `fastaTextToNightingaleMsa()` uppercases sequences and strips whitespace. **Rationale:** published `nucleotide` scheme maps **A/C/G/T/U**; lowercase and many IUPAC chars fall back to a **light/white** fill → **invisible on white canvas** without this normalisation.

3. **Do not set `display-start` / `display-end` on `nightingale-manager`**  
   `syncNightingaleManagerAndTracks` sets **`mgr.length`** and may call **`mgr.applyAttributes()`**, and sets **attributes + props on `nightingale-msa` and `nightingale-navigation` only**.  
   **Why:** if the manager owns `display-start`/`display-end`, it can **reapply them on child `change` events**, **resetting** the MSA viewport after zoom/pan and making interaction feel broken.

4. **Wheel zoom without Ctrl**  
   Published MSA inner viewer defaults to **Ctrl+wheel** for zoom. `relaxNightingaleWheelZoom()` reaches into the `nightingale-msa` shadow root and sets `use-ctrl-to-zoom = false` on `msa-sequence-viewer` after data load (with a double `rAF` retry).

5. **Navigator ruler (“1–1”) and brush**  
   After `.data` is set, **`refreshNightingaleNavigation`** syncs `length`, `display-start` / `display-end`, and calls **`nav.locate(1, brushEnd)`** inside `requestAnimationFrame` so the overview matches the visible window (length was not reliable on first paint).

6. **EBI layout pattern**  
   Same idea as EBI’s MSA story: **`nightingale-manager`** contains **`nightingale-navigation`** above **`nightingale-msa`**. The navigation row sits in a wrapper with **`padding-left` equal to the MSA’s `label-width`** (e.g.140px) so the ruler lines up with the **sequence canvas**, not the sequence **name** column.

---

## Paths, hosting, and data

- **Relative URLs** preferred for `fixtures/` and `?bgzf=` so GitHub Pages and local `python -m http.server` behave; leading `/` breaks on `github.io/<repo>/`.
- **Large fixtures:** SILVA BGZF + indexes are heavy; README summarises size and hosting alternatives.
- **`.nojekyll`:** present for GitHub Pages so static assets are not processed by Jekyll.

---

## Refreshing plot exports (Faerun HTML/JS)

Regenerated Faerun assets **overwrite** `assets/*.html` and large `*.js`. **Preserve** when re-merging:

- **Faerun `updateSelected`:** local patch draws a **crosshair for every** `selectedItems` entry (stock export only shows one). Re-apply the `for (let si = 0; si < n; si++)` indicator loop if you replace the HTML from upstream.
- MSA HUD markup (`#tmap-msa-hud`, manager/nav/msa IDs).
- Module scripts: `bridge.js`, `msa_hud_module.js`, Aioli, Nightingale `import` block.
- `window.TMAP_MSA` / `window.tmapPlotLabelToSeqId` / `window.tmapFaerun` wiring as on the Ty1 vs SILVA pages.

See README “Refreshing plot assets” for the split between SILVA and Ty1.

---

## Ty1 vs SILVA (behavioural)

- **SILVA:** `referenceBase: dna-sequences.fasta.gz`, higher caps, **`msaInitialVisibleColumns: 120`** for long alignments.
- **Ty1:** Smaller default reference (`poc_ty1_nr.fa.gz`), optional **`tmapPlotLabelToSeqId`** if plot labels differ from FASTA ids; full-library plot vs subset fixture is a common “ids missing from FASTA” user trap (handled with status messaging in `msa_hud_module.js`).

---

## Testing mindset

- **Golden / sanity:** optional `TMAP_MSA.goldenId` + `goldenSeqPrefix` + verify button when present.
- After changing Nightingale glue, smoke-test: **first alignment shows colours**, **wheel zoom/pan**, **navigator** reflects range, **clear** hides viewer.

---

## TODO (engineering)

- **Evaluate replacing Faerun / Lore** as the 2D (or 3D) plot front-end—e.g. **Plotly**, **deck.gl**, **Observable Plot**, or another stack—while keeping the same **id ↔ point** contract the HUD relies on (`data[…].labels`, optional `tmapPlotLabelToSeqId`, programmatic multi-select / highlight). No decision recorded yet; compare bundle size, selection API, export path from tmap, and maintenance cost.

---

## Related files (quick index)

| Area | Files |
|------|--------|
| HUD + Nightingale glue | `js/msa_hud_module.js` |
| Plot → ids | `js/bridge.js` |
| SILVA page + imports | `assets/tmap_silva_freqs.html` (tail) |
| Ty1 page | `assets/ty1_rbd_flag_p2_tmap.html` (same pattern; keep in sync when changing HUD) |
| Entry links | `index.html` |
