import type { ItemMap } from "./items.js";

/** Worker `getData` key backing the GitHub tab's MetricCard row. */
export const SUMMARY_DATA_KEY = "github-upstream-summary";

/** Counts behind the GitHub tab's MetricCard row. Open items only. */
export interface UpstreamSummary {
  openPRs: number;
  redCI: number;
  awaitingMaintainer: number;
  awaitingUs: number;
  /** Open tracked items of any kind. */
  openItems: number;
  /** Tracked items with a stored snapshot. */
  trackedItems: number;
  /** Latest per-item check time, or null when nothing was ever scanned. */
  lastScanAt: string | null;
}

export const EMPTY_SUMMARY: UpstreamSummary = {
  openPRs: 0,
  redCI: 0,
  awaitingMaintainer: 0,
  awaitingUs: 0,
  openItems: 0,
  trackedItems: 0,
  lastScanAt: null,
};

/**
 * Aggregate stored item snapshots into tab counts. Reads only the plugin
 * state the item scan already keeps — no GitHub calls, no LLM.
 */
export function summarizeItems(items: ItemMap): UpstreamSummary {
  const summary: UpstreamSummary = { ...EMPTY_SUMMARY };
  for (const record of Object.values(items)) {
    const snapshot = record.snapshot;
    if (!snapshot) continue;
    summary.trackedItems += 1;
    if (record.checkedAt && (!summary.lastScanAt || record.checkedAt > summary.lastScanAt)) {
      summary.lastScanAt = record.checkedAt;
    }
    if (snapshot.state !== "open") continue;
    summary.openItems += 1;
    if (snapshot.kind === "pull") summary.openPRs += 1;
    if (snapshot.checkConclusion === "failure") summary.redCI += 1;
    if (snapshot.awaiting === "maintainer") summary.awaitingMaintainer += 1;
    if (snapshot.awaiting === "us") summary.awaitingUs += 1;
  }
  return summary;
}
