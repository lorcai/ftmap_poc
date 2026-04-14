/**
 * MSA HUD: BGZF + samtools faidx (Aioli) + kalign.
 *
 * Supports:
 * - window.TMAP_MSA.bgzfUrl (e.g. from ?bgzf=…) → mounts .gz + .fai + .gzi at that URL
 * - window.TMAP_MSA.referenceBase + fixturesRel (SILVA / default Ty1 gz in fixtures/)
 * - window.TMAP_MSA.fastaUrl when no BGZF → fetch + parse (small FASTA only)
 */
window.TMAP_MSA = Object.assign(
  {
    referenceBase: "poc_ty1_nr.fa.gz",
    fixturesRel: "../fixtures",
    fastaUrl: null,
    bgzfUrl: null,
    maxAlign: 40,
    maxStaging: 200,
    faidxBatch: 40,
    /** When `#tmap-msa-viewer` exists, push kalign FASTA into Nightingale (see Ty1 HTML). */
    msaColorScheme: "nucleotide",
    /** Nightingale `height` = rows×tile-height + chrome, clamped (avoids huge empty band for few sequences). */
    msaViewerMinHeight: 88,
    msaViewerMaxHeight: 420,
    /** Extra px beyond row tiles (margins inside component); keep small ~1 row or you get a blank band. */
    msaViewerHeightChrome: 14,
  },
  window.TMAP_MSA || {},
);

/**
 * Lore/Faerun: clear selection + highlight points from FASTA ids (staging).
 * Lives here (not only in bridge.js) so “Highlight on plot” works whenever this HUD loads.
 */
(function defineTmapPlotHighlightApi() {
  function tmapLabelToSequenceId(rawLabel) {
    const map =
      typeof window.tmapPlotLabelToSeqId === "function"
        ? window.tmapPlotLabelToSeqId
        : function (s) {
            return s;
          };
    return map(String(rawLabel));
  }

  /**
   * Lore selection entries use different index fields; Faerun’s UI calls
   * `octreeHelpers[source].removeSelected(item.index)` (not `item.item.index`).
   * Clearing with the wrong field no-ops, so Highlight looked like “add only.”
   */
  function pointIndexForRemoveSelected(it) {
    if (typeof it.index === "number") return it.index;
    if (it.item && it.item.e && typeof it.item.e.index === "number") return it.item.e.index;
    if (it.item && typeof it.item.index === "number") return it.item.index;
    return null;
  }

  window.clearTmapPlotSelection = function clearTmapPlotSelection() {
    const f = window.tmapFaerun;
    if (!f || !f.octreeHelpers || !f.selectedItems) return;
    const snapshot = [...f.selectedItems];
    for (const it of snapshot) {
      const oh = f.octreeHelpers[it.source];
      const idx = pointIndexForRemoveSelected(it);
      if (oh && idx != null && typeof oh.removeSelected === "function") {
        oh.removeSelected(idx);
      }
    }
  };

  window.highlightTmapPlotFromSequenceIds = function highlightTmapPlotFromSequenceIds(ids) {
    const faerun = window.tmapFaerun;
    if (typeof data === "undefined" || !faerun || !faerun.ohIndexMap || !faerun.octreeHelpers) {
      return { requested: 0, matched: 0, missing: [] };
    }

    const list = Array.isArray(ids)
      ? ids
      : String(ids)
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean);
    const wanted = new Set(list);

    if (wanted.size === 0) {
      window.clearTmapPlotSelection();
      return { requested: 0, matched: 0, missing: [] };
    }

    window.clearTmapPlotSelection();

    const matchedIds = new Set();
    Object.keys(data).forEach((name) => {
      if (!data[name].labels || !Object.prototype.hasOwnProperty.call(faerun.ohIndexMap, name)) {
        return;
      }
      const ohIdx = faerun.ohIndexMap[name];
      const oh = faerun.octreeHelpers[ohIdx];
      if (!oh || typeof oh.addSelected !== "function") return;

      const labels = data[name].labels;
      for (let i = 0; i < labels.length; i += 1) {
        const seqId = tmapLabelToSequenceId(labels[i]);
        if (wanted.has(seqId)) {
          oh.addSelected(i);
          matchedIds.add(seqId);
        }
      }
    });

    const missing = [...wanted].filter((id) => !matchedIds.has(id));
    return { requested: wanted.size, matched: matchedIds.size, missing };
  };
})();

function $(id) {
  return document.getElementById(id);
}

function setStatus(msg) {
  const el = $("tmap-msa-status");
  if (!el) return;
  const s = msg || "";
  el.textContent = s;
  el.title = s;
}

/** Let the browser paint status text before long WASM / faidx work (avoids “first click does nothing”). */
function yieldForStatusPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

/** Prefer stdout only — stderr (warnings, banners) must not be fed to kalign as FASTA. */
function execToString(res) {
  if (res == null) return "";
  if (typeof res === "string") return res;
  if (typeof res.stdout === "string") return res.stdout;
  if (Array.isArray(res.stdout)) return res.stdout.join("");
  return "";
}

function stripToFirstFastaRecord(s) {
  if (!s || typeof s !== "string") return "";
  const i = s.indexOf(">");
  if (i === -1) return s.trim();
  return s.slice(i).replace(/^\uFEFF/, "").trimEnd();
}

function normalizeFastaForKalign(s) {
  return stripToFirstFastaRecord(String(s).replace(/\r\n/g, "\n").replace(/\r/g, "\n")).trimEnd() + "\n";
}

function looksLikeHttpErrorDoc(s) {
  if (!s || typeof s !== "string") return false;
  const t = s.trimStart();
  return t.startsWith("<!DOCTYPE") || t.startsWith("<html");
}

function stagingIds() {
  const raw = ($("tmap-msa-staging") && $("tmap-msa-staging").value) || "";
  const ids = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(ids)];
}

function appendStaging(ids) {
  const ta = $("tmap-msa-staging");
  if (!ta) return;
  const cur = stagingIds();
  const merged = [...new Set([...cur, ...ids])];
  if (merged.length > window.TMAP_MSA.maxStaging) {
    setStatus(`Staging capped at ${window.TMAP_MSA.maxStaging} ids.`);
    merged.length = window.TMAP_MSA.maxStaging;
  }
  ta.value = merged.join("\n");
}

function resolveUrl(relOrAbs) {
  return new URL(relOrAbs, window.location.href).href;
}

function resolveFixtureUrl(filename) {
  const rel = `${window.TMAP_MSA.fixturesRel.replace(/\/?$/, "/")}${filename}`;
  return resolveUrl(rel);
}

/** @returns {{ baseFilename: string, mountSpecs: {name: string, url: string}[] }} */
function referenceMountPlan() {
  const m = window.TMAP_MSA;
  if (m.bgzfUrl) {
    const baseHref = resolveUrl(m.bgzfUrl);
    const path = new URL(m.bgzfUrl, window.location.href).pathname;
    const baseFilename = path.split("/").pop() || "reference.fa.gz";
    return {
      baseFilename,
      mountSpecs: [
        { name: baseFilename, url: baseHref },
        { name: `${baseFilename}.fai`, url: `${baseHref}.fai` },
        { name: `${baseFilename}.gzi`, url: `${baseHref}.gzi` },
      ],
    };
  }
  const b = m.referenceBase;
  if (!b) throw new Error("TMAP_MSA.referenceBase or bgzfUrl is required for indexed FASTA");
  return {
    baseFilename: b,
    mountSpecs: [
      { name: b, url: resolveFixtureUrl(b) },
      { name: `${b}.fai`, url: resolveFixtureUrl(`${b}.fai`) },
      { name: `${b}.gzi`, url: resolveFixtureUrl(`${b}.gzi`) },
    ],
  };
}

let _cli = null;
let _mountKey = "";
let _kalignOnly = null;

async function getKalignOnlyCli() {
  if (_kalignOnly) return _kalignOnly;
  if (typeof Aioli === "undefined") {
    throw new Error("Aioli not loaded (https://biowasm.com/cdn/v3/aioli.js)");
  }
  setStatus("Loading kalign (WASM)…");
  _kalignOnly = await new Aioli(["kalign/3.3.1"], { printInterleaved: false });
  return _kalignOnly;
}

function useKalignOnlyNoSamtoolsMount() {
  const m = window.TMAP_MSA;
  return (
    Boolean(m.fastaUrl) &&
    !m.bgzfUrl &&
    !(m.referenceBase && String(m.referenceBase).endsWith(".gz"))
  );
}

async function getCli() {
  const plan = referenceMountPlan();
  const key = JSON.stringify(plan.mountSpecs.map((x) => x.url));
  if (_cli && _mountKey === key) return _cli;
  _cli = null;
  _mountKey = key;

  if (typeof Aioli === "undefined") {
    throw new Error("Aioli not loaded (https://biowasm.com/cdn/v3/aioli.js)");
  }
  setStatus("Loading samtools + kalign (WASM)…");
  const cli = await new Aioli(["samtools/1.21", "kalign/3.3.1"], {
    printInterleaved: false,
  });
  await cli.mount(plan.mountSpecs);
  _cli = cli;
  window.TMAP_MSA._faidxFilename = plan.baseFilename;
  return _cli;
}

async function samtoolsFaidxMulti(ids) {
  const cli = await getCli();
  const b = window.TMAP_MSA._faidxFilename || referenceMountPlan().baseFilename;
  setStatus("Reading sequences from reference…");
  let fasta = "";
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const res = await cli.exec("samtools", ["faidx", b, id]);
    let part = normalizeFastaForKalign(execToString(res));
    if (looksLikeHttpErrorDoc(part)) {
      throw new Error("faidx returned HTML (check .fa.gz / .fai / .gzi URLs and CORS).");
    }
    if (!part.startsWith(">")) continue;
    fasta += part;
  }
  return fasta;
}

let _plainMap = null;
let _plainMapUrl = "";

function parseFastaText(text) {
  const map = new Map();
  let id = null;
  const buf = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(">")) {
      if (id != null) map.set(id, buf.join(""));
      id = line.slice(1).split(/\s/)[0];
      buf.length = 0;
    } else buf.push(line);
  }
  if (id != null) map.set(id, buf.join(""));
  return map;
}

/**
 * Nightingale `nucleotide` colors only know A,C,G,T,U; other chars use default #fff → invisible on white.
 * Kalign often emits lowercase; gaps `-`/`.` are unmapped → same. Uppercase + keep gaps as ASCII.
 * @returns {{ name: string, sequence: string }[]}
 */
function fastaTextToNightingaleMsa(text) {
  if (!text || typeof text !== "string" || !text.includes(">")) return [];
  const m = parseFastaText(text);
  const out = [];
  for (const [name, sequence] of m) {
    if (sequence) {
      out.push({
        name,
        sequence: String(sequence).replace(/\s+/g, "").toUpperCase(),
      });
    }
  }
  return out;
}

function hideNightingaleMsaViewer() {
  const wrap = $("tmap-msa-viewer-wrap");
  if (wrap) wrap.hidden = true;
}

/** CDN build defaults to Ctrl+wheel zoom; disable so wheel zoom works in the HUD. */
function relaxNightingaleWheelZoom() {
  const host = $("tmap-msa-viewer");
  if (!host || !host.shadowRoot) return;
  const sv = host.shadowRoot.querySelector("msa-sequence-viewer");
  if (!sv) return;
  try {
    sv["use-ctrl-to-zoom"] = false;
  } catch (_) {
    /* ignore */
  }
}

/** Set `nightingale-msa` height from row count so small alignments don’t leave a tall empty viewport. */
function applyNightingaleMsaViewportHeight(msaEl, rowCount) {
  if (!msaEl || rowCount < 1) return;
  const cfg = window.TMAP_MSA || {};
  const tile = Number(msaEl.getAttribute("tile-height")) || 22;
  const minH = Number(cfg.msaViewerMinHeight) || 88;
  const maxH = Number(cfg.msaViewerMaxHeight) || 420;
  const chrome = Number(cfg.msaViewerHeightChrome) || 14;
  const h = Math.min(maxH, Math.max(minH, rowCount * tile + chrome));
  msaEl.setAttribute("height", String(Math.round(h)));
}

/**
 * Keep nightingale-manager length + initial display on MSA/nav in sync.
 * Do NOT set manager display-start/display-end: the manager reapplies them on every
 * child `change` (zoom/pan), which would reset the MSA viewport and break interaction.
 * See https://ebi-webcomponents.github.io/nightingale/?path=/story/components-tracks-alignments--msa
 */
function syncNightingaleManagerAndTracks(msaEl, rows) {
  applyNightingaleMsaViewportHeight(msaEl, rows.length);
  const mgr = msaEl.closest("nightingale-manager");
  const len = Math.max(...rows.map((r) => r.sequence.length));
  const cfg = window.TMAP_MSA || {};
  const maxInit = Number(cfg.msaInitialVisibleColumns) || 0;
  const useWindow = maxInit > 0 && len > maxInit;
  const displayEndStr = useWindow ? String(maxInit) : "-1";

  msaEl.setAttribute("display-start", "1");
  msaEl.setAttribute("display-end", displayEndStr);

  const nav = document.getElementById("tmap-msa-navigation");
  if (nav) {
    nav.length = len;
    nav["display-start"] = 1;
    nav["display-end"] = useWindow ? maxInit : -1;
    nav.setAttribute("length", String(len));
    nav.setAttribute("display-start", "1");
    nav.setAttribute("display-end", displayEndStr);
  }

  if (mgr) {
    mgr.length = len;
    if (typeof mgr.applyAttributes === "function") {
      mgr.applyAttributes();
    }
  }
}

/** Ruler labels show 1–1 until length + brush apply after layout; re-run after MSA has .data. */
function refreshNightingaleNavigation(rows) {
  const nav = document.getElementById("tmap-msa-navigation");
  if (!nav || !rows.length) return;
  const len = Math.max(...rows.map((r) => r.sequence.length));
  const cfg = window.TMAP_MSA || {};
  const maxInit = Number(cfg.msaInitialVisibleColumns) || 0;
  const useWindow = maxInit > 0 && len > maxInit;
  const displayEnd = useWindow ? maxInit : -1;
  const brushEnd = useWindow ? maxInit : len;

  nav.length = len;
  nav["display-start"] = 1;
  nav["display-end"] = displayEnd;
  nav.setAttribute("length", String(len));
  nav.setAttribute("display-start", "1");
  nav.setAttribute("display-end", useWindow ? String(maxInit) : "-1");

  if (typeof nav.requestUpdate === "function") nav.requestUpdate();

  requestAnimationFrame(() => {
    if (typeof nav.locate === "function") {
      try {
        nav.locate(1, brushEnd);
      } catch (_) {
        /* ignore */
      }
    }
    if (typeof nav.requestUpdate === "function") nav.requestUpdate();
  });
}

function updateNightingaleMsaFromFasta(fastaText) {
  const wrap = $("tmap-msa-viewer-wrap");
  const el = $("tmap-msa-viewer");
  if (!wrap || !el) return;
  const rows = fastaTextToNightingaleMsa(fastaText);
  if (!rows.length) {
    wrap.hidden = true;
    return;
  }
  const scheme =
    (window.TMAP_MSA && window.TMAP_MSA.msaColorScheme) || "nucleotide";
  if (el.getAttribute("color-scheme") !== scheme) {
    el.setAttribute("color-scheme", scheme);
  }
  const apply = () => {
    /* Unhide before .data so width/height are non-zero (hidden subtree often measures 0). */
    wrap.hidden = false;
    const pushData = () => {
      syncNightingaleManagerAndTracks(el, rows);
      el.data = rows;
      /* `.data` can reset internal layout; keep height tight after bind. */
      applyNightingaleMsaViewportHeight(el, rows.length);
      requestAnimationFrame(() => {
        relaxNightingaleWheelZoom();
        requestAnimationFrame(() => {
          relaxNightingaleWheelZoom();
          refreshNightingaleNavigation(rows);
        });
      });
    };
    requestAnimationFrame(() => requestAnimationFrame(pushData));
  };
  if (customElements.get("nightingale-msa")) apply();
  else customElements.whenDefined("nightingale-msa").then(apply);
}

/** Ids requested but absent from fetched FASTA (wrong reference or truncated fixture). */
function idsMissingFromFasta(ids, fastaText) {
  const m = parseFastaText(fastaText);
  return ids.filter((id) => !m.has(id));
}

async function fetchPlainFastaSequences(ids) {
  const m = window.TMAP_MSA;
  if (!m.fastaUrl) {
    throw new Error("No fastaUrl — use ?bgzf=… or ship .fa.gz + indexes.");
  }
  const url = resolveUrl(m.fastaUrl);
  if (_plainMap && _plainMapUrl === url) {
    /* use cache */
  } else {
    setStatus("Loading uncompressed FASTA…");
    const r = await fetch(url);
    if (!r.ok) throw new Error(`FASTA fetch ${r.status} ${url}`);
    const text = await r.text();
    if (looksLikeHttpErrorDoc(text)) throw new Error("FASTA URL returned HTML (404?).");
    _plainMap = parseFastaText(text);
    _plainMapUrl = url;
  }
  let out = "";
  for (const id of ids) {
    const seq = _plainMap.get(id);
    if (seq) out += normalizeFastaForKalign(`>${id}\n${seq}`);
  }
  return out;
}

async function sequencesForIds(ids) {
  const m = window.TMAP_MSA;
  if (m.bgzfUrl || (m.referenceBase && String(m.referenceBase).endsWith(".gz"))) {
    return samtoolsFaidxMulti(ids);
  }
  if (m.fastaUrl) return fetchPlainFastaSequences(ids);
  throw new Error("Set TMAP_MSA.bgzfUrl, referenceBase (*.gz), or fastaUrl");
}

async function readCat(cli, paths) {
  if (typeof cli.cat !== "function") return null;
  const list = Array.isArray(paths) ? paths : [paths];
  for (const path of list) {
    try {
      const r = await cli.cat(path);
      if (typeof r === "string" && r.includes(">")) return r;
      if (r instanceof Uint8Array && r.length) {
        const t = new TextDecoder().decode(r);
        if (t.includes(">")) return t;
      }
    } catch (_) {
      /* try next path */
    }
  }
  return null;
}

async function readVfsText(cli, paths) {
  for (const p of paths) {
    try {
      if (cli.fs && typeof cli.fs.readFile === "function") {
        const u8 = await cli.fs.readFile(p);
        if (u8 && u8.length) return new TextDecoder().decode(u8);
      }
    } catch (_) {
      /* try next */
    }
  }
  for (const p of paths) {
    try {
      const url = await cli.download(p);
      /* Aioli may return false when the file is missing — never fetch() that. */
      if (url == null || url === false || typeof url !== "string") continue;
      const r = await fetch(url);
      const t = await r.text();
      if (typeof url === "string" && url.startsWith("blob:")) {
        try {
          URL.revokeObjectURL(url);
        } catch (_) {
          /* ignore */
        }
      }
      if (t && !looksLikeHttpErrorDoc(t)) return t;
    } catch (_) {
      /* try next */
    }
  }
  return null;
}

async function runKalignOnFasta(fastaText) {
  const cli = useKalignOnlyNoSamtoolsMount()
    ? await getKalignOnlyCli()
    : await getCli();
  const cleanIn = normalizeFastaForKalign(fastaText);
  await cli.mount([{ name: "msa_in.fa", data: cleanIn }]);

  /* Match biowasm.com example: full command string + CLI.cat for output */
  const run = await cli.exec("kalign msa_in.fa -f fasta -o msa_out.fa");
  const errOnly = typeof run === "object" && run && run.stderr ? String(run.stderr) : "";

  let text = await readCat(cli, ["msa_out.fa", "/msa_out.fa", "./msa_out.fa"]);
  if (text && text.includes(">")) return text;

  text = await readVfsText(cli, [
    "msa_out.fa",
    "/msa_out.fa",
    "./msa_out.fa",
    "result.fasta",
  ]);
  if (text && text.includes(">")) return text;

  const out = execToString(run);
  if (out && out.includes(">") && !looksLikeHttpErrorDoc(out)) return out;

  const hint = errOnly
    ? ` kalign stderr (tail): ${errOnly.trim().slice(-400)}`
    : "";
  throw new Error(
    `Could not read kalign output (msa_out.fa).${hint} Try fewer or shorter sequences.`,
  );
}

window.initMsaHud = function initMsaHud() {
  if (window.__tmapMsaHudBound) return;
  window.__tmapMsaHudBound = true;

  const sync = $("tmap-msa-sync");
  const highlightPlot = $("tmap-msa-highlight-plot");
  const clear = $("tmap-msa-clear");
  const run = $("tmap-msa-kalign");
  const dl = $("tmap-msa-download");
  const copy = $("tmap-msa-copy-ids");
  const out = $("tmap-msa-out");

  let lastAln = "";

  if (sync) {
    sync.addEventListener("click", () => {
      if (typeof window.getSelectedSequenceIds !== "function") {
        setStatus("bridge.js missing — load ../js/bridge.js before this script.");
        return;
      }
      const ids = window.getSelectedSequenceIds();
      if (!ids || !ids.length) {
        setStatus("No points selected on the plot.");
        return;
      }
      appendStaging(ids);
      setStatus(`Synced ${ids.length} id(s) from plot.`);
    });
  }

  if (highlightPlot) {
    highlightPlot.addEventListener("click", () => {
      const ids = stagingIds();
      if (!ids.length) {
        window.clearTmapPlotSelection();
        setStatus("Staging empty — cleared plot selection.");
        return;
      }
      const r = window.highlightTmapPlotFromSequenceIds(ids);
      if (r.missing.length) {
        const sample = r.missing.slice(0, 5).join(", ") + (r.missing.length > 5 ? " …" : "");
        setStatus(
          `Plot: matched ${r.matched}/${r.requested} id(s). Not on plot: ${sample}`,
        );
      } else {
        setStatus(`Plot: highlighted ${r.matched} id(s).`);
      }
    });
  }

  if (clear) {
    clear.addEventListener("click", () => {
      const ta = $("tmap-msa-staging");
      if (ta) ta.value = "";
      if (out) out.textContent = "";
      lastAln = "";
      hideNightingaleMsaViewer();
      setStatus("Cleared staging.");
    });
  }

  if (copy) {
    copy.addEventListener("click", async () => {
      const ids = stagingIds();
      if (!ids.length) {
        setStatus("Nothing to copy.");
        return;
      }
      try {
        await navigator.clipboard.writeText(ids.join("\n"));
        setStatus(`Copied ${ids.length} id(s).`);
      } catch (e) {
        setStatus("Clipboard failed — copy from staging manually.");
      }
    });
  }

  if (run) {
    run.addEventListener("click", async () => {
      const ids = stagingIds();
      if (!ids.length) {
        setStatus("Add ids to staging (or Sync from plot).");
        return;
      }
      if (ids.length > window.TMAP_MSA.maxAlign) {
        setStatus(`At most ${window.TMAP_MSA.maxAlign} sequences for kalign in this demo.`);
        return;
      }
      if (ids.length < 2) {
        setStatus(
          "Kalign needs at least 2 sequences (multiple alignment). Sync or stage 2+ ids, then run again.",
        );
        return;
      }
      try {
        setStatus("Fetching sequences…");
        await yieldForStatusPaint();
        const fasta = await sequencesForIds(ids);
        if (!fasta || !fasta.includes(">")) {
          setStatus("No FASTA records — ids may not match reference (check Ty1 label → id mapping).");
          return;
        }
        if (looksLikeHttpErrorDoc(fasta)) {
          setStatus("Fetch/index error (HTML response). Check network tab.");
          return;
        }
        const missing = idsMissingFromFasta(ids, fasta);
        if (missing.length) {
          const sample = missing.slice(0, 3).join(", ") + (missing.length > 3 ? " …" : "");
          setStatus(
            `${missing.length} id(s) not in this reference (e.g. ${sample}). The plot may list the full library while ?bgzf= points at a small fixture — pick points in that subset or use the full P2 link.`,
          );
          return;
        }
        setStatus("Running kalign…");
        lastAln = await runKalignOnFasta(fasta);
        if (out) out.textContent = lastAln;
        updateNightingaleMsaFromFasta(lastAln);
        setStatus(`Aligned ${ids.length} sequence(s).`);
      } catch (e) {
        console.error(e);
        setStatus(e.message || String(e));
      }
    });
  }

  if (dl) {
    dl.addEventListener("click", () => {
      if (!lastAln) {
        setStatus("Run kalign first.");
        return;
      }
      const blob = new Blob([lastAln], { type: "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "tmap_msa.fa";
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }

  const goldenBtn = $("tmap-msa-verify-golden");
  const gId = window.TMAP_MSA && window.TMAP_MSA.goldenId;
  const gPre = window.TMAP_MSA && window.TMAP_MSA.goldenSeqPrefix;
  if (goldenBtn && gId && gPre) {
    goldenBtn.style.display = "";
    goldenBtn.addEventListener("click", async () => {
      try {
        setStatus("Fetching golden id…");
        const fasta = await sequencesForIds([gId]);
        const map = parseFastaText(fasta);
        const seq = map.get(gId);
        if (!seq) {
          setStatus(`Golden id not in reference: ${gId}`);
          return;
        }
        if (seq.startsWith(gPre)) setStatus("Golden id: sequence prefix OK.");
        else setStatus("Golden id: sequence prefix mismatch.");
      } catch (e) {
        console.error(e);
        setStatus(e.message || String(e));
      }
    });
  }
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => window.initMsaHud());
} else {
  window.initMsaHud();
}
