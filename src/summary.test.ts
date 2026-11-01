import { describe, expect, it } from "vitest";
import type { ItemMap } from "./items.js";
import type { ItemSnapshot } from "./mapping.js";
import { EMPTY_SUMMARY, summarizeItems } from "./summary.js";

const snapshot = (extra: Partial<ItemSnapshot> = {}): ItemSnapshot => ({
  owner: "paperclipai",
  repo: "paperclip",
  kind: "pull",
  number: 1,
  url: "https://github.com/paperclipai/paperclip/pull/1",
  title: "pr 1",
  state: "open",
  updatedAt: "2026-10-12T00:00:00Z",
  commentCount: 0,
  authorLogin: "Rick7C2",
  headLabel: "TogetherWeOwn:fix-x",
  reviewCount: 0,
  latestReviewState: null,
  checkConclusion: "success",
  headSha: null,
  draft: false,
  awaiting: "maintainer",
  ...extra,
});

const record = (snap: ItemSnapshot | null, checkedAt = "2026-11-01T00:00:00Z") => ({
  etags: {},
  resolvedKind: snap?.kind ?? null,
  fingerprint: "f",
  wokenFingerprint: "f",
  snapshot: snap,
  cardId: "card-1",
  checkedAt,
});

describe("summarizeItems", () => {
  it("returns zeros for an empty map", () => {
    expect(summarizeItems({})).toEqual(EMPTY_SUMMARY);
  });

  it("counts open items only, skipping records without snapshots or cards", () => {
    const items: ItemMap = {
      "paperclipai/paperclip#1": record(snapshot({ number: 1, awaiting: "maintainer" }), "2026-11-01T01:00:00Z"),
      "paperclipai/paperclip#2": record(snapshot({ number: 2, awaiting: "us", checkConclusion: "failure" }), "2026-11-01T02:00:00Z"),
      "paperclipai/paperclip#3": record(snapshot({ number: 3, kind: "issue", awaiting: "maintainer", checkConclusion: "none" })),
      "paperclipai/paperclip#4": record(snapshot({ number: 4, state: "merged", awaiting: null })),
      "paperclipai/paperclip#5": record(snapshot({ number: 5, state: "closed", awaiting: null })),
      "paperclipai/paperclip#6": record(null),
      // A card-less record (not-ours extra) is invisible in the tab: skipped.
      "paperclipai/paperclip#7": { ...record(snapshot({ number: 7 })), cardId: null },
    };
    expect(summarizeItems(items)).toEqual({
      openPRs: 2,
      redCI: 1,
      awaitingMaintainer: 2,
      awaitingUs: 1,
      openItems: 3,
      trackedItems: 5,
      lastScanAt: "2026-11-01T02:00:00Z",
    });
  });
});
