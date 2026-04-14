/**
 * Map Faerun selection → FASTA ids used for faidx / staging.
 *
 * Uses each point's scatter `labels` entry (same as hover text from Faerun).
 * Optional: set window.tmapPlotLabelToSeqId = function (label) { return id; }
 * when the plot label is not already the FASTA id (e.g. Ty1 species labels).
 */
function tmapLabelToSequenceId(rawLabel) {
  const map =
    typeof window.tmapPlotLabelToSeqId === "function"
      ? window.tmapPlotLabelToSeqId
      : function (s) {
          return s;
        };
  return map(String(rawLabel));
}

/** Plot → FASTA ids for Sync (Highlight on plot is implemented in msa_hud_module.js). */
window.getSelectedSequenceIds = function getSelectedSequenceIds() {
  const faerun = window.tmapFaerun;
  if (!faerun || !faerun.selectedItems || !faerun.selectedItems.length) return [];

  const out = [];
  for (let i = 0; i < faerun.selectedItems.length; i++) {
    const item = faerun.selectedItems[i];
    const phName = faerun.ohIndexToPhName[item.source];
    if (typeof data === "undefined" || !data[phName] || !data[phName].labels) continue;
    const raw = String(data[phName].labels[item.item.index]);
    out.push(tmapLabelToSequenceId(raw));
  }
  return [...new Set(out)];
};
