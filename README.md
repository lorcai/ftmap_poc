# ftmap_poc

Proof of concept for static site: **SILVA** tmap demo, **Ty1** Faerun + MSA HUD (BioWasm **kalign** + **samtools faidx** on BGZF), and small BioWasm spikes.

The POC covers the following features:
- Interactive tmap demos for silva and ty1 datasets
- Extraction of sequences from bgzf compressed fasta files using biowasm
- Alignment of sequences using biowasm kalign
- Paste or sync **FASTA ids into the shared staging box**, then **Highlight on plot** to select the matching points on the tmap (same ids as kalign). No need to click each dot first when you already have a list.

## Run locally

```bash
python -m http.server 8080
```

Open **http://localhost:8080/** — see [`index.html`](index.html) for links.

### Large fixtures (clone size)

Vendored **SILVA** BGZF + indexes under `fixtures/` are ~**110 MiB** combined (`dna-sequences.fasta.gz` + `.fai` + `.gzi`). Under GitHub’s **~100 MiB per file** limit, but heavy for clones. For a slimmer repo, drop SILVA from `fixtures/` and host data elsewhere (CORS + HTTPS), then point `TMAP_MSA` / `?bgzf=` at those URLs.

## Paths and `?bgzf=`

| Form | Use |
|------|-----|
| **Relative** (e.g. `../fixtures/foo.fa.gz`) | Works on Pages and locally; **preferred** for files in this repo. |
| **`https://…`** | Any CORS-allowed URL. |
| **Leading `/…`** | Host root only — often **wrong** on `github.io/<repo>/`; prefer **relative** paths. |

## Fixtures (summary)

| Bundle | Role |
|--------|------|
| `dna-sequences.fasta.gz` (+ `.fai`, `.gzi`) | SILVA reference for [`assets/tmap_silva_freqs.html`](assets/tmap_silva_freqs.html) |
| `RBD-flag-P2.trimmed.fa.gz` (+ indexes) | Full Ty1 library for `?bgzf=../fixtures/RBD-flag-P2.trimmed.fa.gz` |
| `poc_ty1_nr.*` | Tiny Ty1 subset; plot still shows **full** Ty1 — align only ids present in this subset (or use full P2). |

Rebuild indexes after editing uncompressed FASTA: `bgzip` then `samtools faidx` on the `.fa.gz`, then replace the `.gz`, `.fai`, and `.gzi`.

## Refreshing plot assets

- **SILVA:** replace `assets/tmap_silva_freqs.html` + `assets/tmap_silva_freqs.js` from your Faerun export; keep the HUD block + `bridge.js` / `msa_hud_module.js` / Aioli / `TMAP_MSA` snippet at the bottom of the HTML.
- **Ty1:** replace `assets/ty1_rbd_flag_p2_tmap.html` + `.js`; re-apply `window.tmapFaerun`, HUD markup, `TMAP_MSA`, `tmapPlotLabelToSeqId`, `bridge.js`, Aioli, `msa_hud_module.js`.

## Conda (bgzip and samtools faidx for preparing bgzf compressed fasta files)

[`environment.yml`](environment.yml): Python only. For **`samtools` / `bgzip`** use **Linux, macOS, or WSL** + Bioconda:

```bash
conda env create -f environment.yml
conda activate ftmap_poc
conda install -c conda-forge -c bioconda "samtools>=1.21"
```

## Engineering / design decisions

For **Nightingale integration**, `TMAP_MSA` contract, and pitfalls (manager viewport, navigator, CDN vs reference tree), see [`ENGINEERING.md`](ENGINEERING.md).

## Layout

- `assets/` — Faerun HTML + large `*.js` plot data
- `fixtures/` — FASTA / BGZF + `.fai` / `.gzi`
- `js/bridge.js` — selection → FASTA ids
- `js/msa_hud_module.js` — faidx + kalign HUD
- `.nojekyll` — disable Jekyll on Pages
