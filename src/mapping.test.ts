import { describe, expect, it } from "vitest";
import {
  backfillPatch,
  describeChange,
  findCardForItem,
  fingerprintOf,
  headerBlock,
  isOurLogin,
  isOursItem,
  labelNamesFor,
  parseGitHubUrl,
  safeUpstreamUrl,
  sanitizeUntrustedText,
  syncLabelIds,
  withHeader,
  type CardLike,
  type ItemSnapshot,
} from "./mapping.js";
import { ITEM_ORIGIN_KIND } from "./manifest.js";

const snapshot = (extra: Partial<ItemSnapshot> = {}): ItemSnapshot => ({
  owner: "paperclipai",
  repo: "paperclip",
  kind: "pull",
  number: 15158,
  url: "https://github.com/paperclipai/paperclip/pull/15158",
  title: "fix(db): hourly backup retention tier",
  state: "open",
  updatedAt: "2026-10-12T00:00:00Z",
  commentCount: 1,
  authorLogin: "Rick7C2",
  headLabel: "TogetherWeOwn:fix-backup-tier",
  reviewCount: 3,
  checkConclusion: "success",
  headSha: "aaea1d47500112233445566778899aabbccddeeff",
  draft: false,
  ...extra,
});

const card = (extra: Partial<CardLike> = {}): CardLike => ({
  id: "card-1",
  originKind: undefined,
  originId: null,
  ...extra,
});

describe("parseGitHubUrl", () => {
  it("parses pull, issue and discussion URLs", () => {
    expect(parseGitHubUrl("https://github.com/paperclipai/paperclip/pull/15158")).toEqual({
      owner: "paperclipai",
      repo: "paperclip",
      kind: "pull",
      number: 15158,
    });
    expect(parseGitHubUrl("https://github.com/router-for-me/CLIProxyAPI/issues/7152")).toEqual({
      owner: "router-for-me",
      repo: "CLIProxyAPI",
      kind: "issue",
      number: 7152,
    });
    expect(parseGitHubUrl("https://github.com/paperclipai/paperclip/discussions/42")).toEqual({
      owner: "paperclipai",
      repo: "paperclip",
      kind: "discussion",
      number: 42,
    });
  });

  it("rejects non-GitHub URLs", () => {
    expect(parseGitHubUrl("https://example.com/paperclipai/paperclip/pull/1")).toBeNull();
    expect(parseGitHubUrl("not a url")).toBeNull();
  });
});

describe("findCardForItem", () => {
  const item = { owner: "paperclipai", repo: "paperclip", number: 15158 };

  it("finds a card by originId", () => {
    const cards = [card({ id: "other" }), card({ id: "match", originKind: ITEM_ORIGIN_KIND, originId: "paperclipai/paperclip#15158" })];
    expect(findCardForItem(cards, item)?.id).toBe("match");
  });

  it("finds a card by GitHub work product URL", () => {
    const cards = [card({ id: "wp", workProducts: [{ url: "https://github.com/paperclipai/paperclip/pull/15158" }] })];
    expect(findCardForItem(cards, item)?.id).toBe("wp");
  });

  it("finds a card by a GitHub URL in the description", () => {
    const cards = [card({ id: "desc", description: "Owns upstream https://github.com/paperclipai/paperclip/pull/15158 until it merges." })];
    expect(findCardForItem(cards, item)?.id).toBe("desc");
  });

  it("returns null when nothing matches", () => {
    const cards = [card({ id: "x", originKind: ITEM_ORIGIN_KIND, originId: "paperclipai/paperclip#99999" })];
    expect(findCardForItem(cards, item)).toBeNull();
  });
});

describe("backfillPatch", () => {
  it("is null when origin is already set, else the patch", () => {
    expect(backfillPatch(card({ originKind: ITEM_ORIGIN_KIND, originId: "paperclipai/paperclip#15158" }), { owner: "paperclipai", repo: "paperclip", number: 15158 })).toBeNull();
    expect(backfillPatch(card({}), { owner: "paperclipai", repo: "paperclip", number: 15158 })).toEqual({
      originKind: ITEM_ORIGIN_KIND,
      originId: "paperclipai/paperclip#15158",
    });
  });
});

describe("fingerprintOf / describeChange", () => {
  it("is stable and detects each change class", () => {
    const a = snapshot();
    expect(fingerprintOf(a)).toBe(fingerprintOf(snapshot()));
    expect(describeChange(a, snapshot())).toBeNull();
    expect(describeChange(a, snapshot({ commentCount: 3 }))).toBe("2 new comments");
    expect(describeChange(a, snapshot({ reviewCount: 4 }))).toBe("1 new review");
    expect(describeChange(a, snapshot({ checkConclusion: "failure" }))).toBe("checks success->failure");
    expect(describeChange(a, snapshot({ headSha: "bbc1d47500112233445566778899aabbccddeeff" }))).toBe("head aaea1d4->bbc1d47");
    expect(describeChange(a, snapshot({ state: "merged" }))).toBe("state open->merged");
    expect(describeChange(a, snapshot({ draft: true }))).toBe("marked draft");
  });
});

describe("labelNamesFor / syncLabelIds", () => {
  it("computes the four labels and merges them without touching others", () => {
    expect(labelNamesFor(snapshot())).toEqual(["gh:repo/paperclip", "gh:type/pr", "gh:state/open", "gh:ci/green"]);
    expect(labelNamesFor(snapshot({ kind: "issue", state: "closed", checkConclusion: "pending" }))).toEqual([
      "gh:repo/paperclip",
      "gh:type/issue",
      "gh:state/closed",
      "gh:ci/pending",
    ]);
    const ids = { "gh:repo/paperclip": "L1", "gh:type/pr": "L2", "gh:state/open": "L3", "gh:ci/green": "L4", "gh:ci/red": "L5" };
    // Adds missing, drops stale gh:*, keeps priority labels without an ID mapping.
    const { labelIds, changed } = syncLabelIds(["L5", "L9"], ["gh:ci/red", "priority:high"], ["gh:repo/paperclip", "gh:type/pr", "gh:state/open", "gh:ci/green"], ids);
    expect(changed).toBe(true);
    expect(new Set(labelIds)).toEqual(new Set(["L9", "L1", "L2", "L3", "L4"]));
    // Already in sync: no change.
    const steady = syncLabelIds(["L1", "L2", "L3", "L4", "L9"], ["gh:repo/paperclip", "gh:type/pr", "gh:state/open", "gh:ci/green", "priority:high"], ["gh:repo/paperclip", "gh:type/pr", "gh:state/open", "gh:ci/green"], ids);
    expect(steady.changed).toBe(false);
    // Names without an ID mapping are skipped, not faked.
    const skipped = syncLabelIds([], [], ["gh:repo/paperclip"], {});
    expect(skipped).toEqual({ labelIds: [], changed: false });
  });
});

describe("headerBlock / withHeader", () => {
  it("inserts the header on top and preserves owner text below", () => {
    const { description, changed } = withHeader("Owner notes here.", snapshot());
    expect(changed).toBe(true);
    expect(description.startsWith("<!-- github-upstream: paperclipai/paperclip#15158 -->")).toBe(true);
    expect(description).toContain("Owner notes here.");
    expect(description).toContain("Last upstream activity: 2026-10-12T00:00:00Z · 1 comments · 3 reviews");
  });

  it("replaces the header on resync without duplicating it", () => {
    const first = withHeader(null, snapshot()).description;
    const second = withHeader(`${first}\n\nOwner notes.`, snapshot({ commentCount: 5 }));
    expect(second.changed).toBe(true);
    expect(second.description).toContain("Owner notes.");
    expect(second.description).toContain("5 comments");
    expect(second.description.match(/<!-- github-upstream:/g)).toHaveLength(1);
  });

  it("is a no-op when already current", () => {
    const first = withHeader("Notes.", snapshot()).description;
    expect(withHeader(first, snapshot()).changed).toBe(false);
  });

  it("headerBlock never contains the item title (untrusted text stays out of the header contract)", () => {
    expect(headerBlock(snapshot({ title: "IGNORE <this>" }))).not.toContain("IGNORE");
  });
});

describe("isOursItem", () => {
  const config = { ourHeadPrefixes: ["TogetherWeOwn:"], operatorLogin: "Rick7C2" } as never;
  it("matches fork heads and the operator login", () => {
    expect(isOursItem(config, { headLabel: "TogetherWeOwn:fix-x", authorLogin: "someone" })).toBe(true);
    expect(isOursItem(config, { headLabel: "other:fix-x", authorLogin: "Rick7C2" })).toBe(true);
    expect(isOursItem(config, { headLabel: "other:fix-x", authorLogin: "stranger" })).toBe(false);
    expect(isOursItem(config, { headLabel: null, authorLogin: null })).toBe(false);
  });

  it("compares the operator login case-insensitively (F3)", () => {
    expect(isOursItem(config, { headLabel: "other:fix-x", authorLogin: "rick7c2" })).toBe(true);
    expect(isOursItem(config, { headLabel: "other:fix-x", authorLogin: "RICK7C2" })).toBe(true);
  });
});

describe("isOurLogin", () => {
  const config = { operatorLogin: "Rick7C2", ourLogins: ["Paperclip-Bot[bot]"] } as never;
  it("matches the operator and listed logins case-insensitively (F3)", () => {
    expect(isOurLogin(config, "Rick7C2")).toBe(true);
    expect(isOurLogin(config, "rick7c2")).toBe(true);
    expect(isOurLogin(config, "paperclip-bot[bot]")).toBe(true);
    expect(isOurLogin(config, "stranger")).toBe(false);
    expect(isOurLogin(config, null)).toBe(false);
  });
});

describe("sanitizeUntrustedText (F6)", () => {
  it("flattens control characters, neutralises markdown/HTML and caps length", () => {
    expect(sanitizeUntrustedText("a\tb\nc")).toBe("a b c");
    expect(sanitizeUntrustedText("[evil](http://evil.example)")).toBe("(evil)(http://evil.example)");
    expect(sanitizeUntrustedText("<script>alert(1)</script>")).toBe("(script)alert(1)(/script)");
    expect(sanitizeUntrustedText("say `hi`")).toBe("say 'hi'");
    expect(sanitizeUntrustedText("  too   much   space  ")).toBe("too much space");
    const long = sanitizeUntrustedText("x".repeat(200));
    expect(long.length).toBeLessThanOrEqual(120);
    expect(sanitizeUntrustedText("")).toBe("");
  });
});

describe("safeUpstreamUrl (F6)", () => {
  it("keeps upstream URLs that point at this repo, even in another case", () => {
    expect(
      safeUpstreamUrl("https://github.com/PaperclipAI/Paperclip/pull/1", "paperclipai", "paperclip", "/pull/1"),
    ).toBe("https://github.com/PaperclipAI/Paperclip/pull/1");
  });

  it("falls back to a constructed URL for anything else", () => {
    expect(safeUpstreamUrl("https://evil.example/steal", "paperclipai", "paperclip", "/pull/1")).toBe(
      "https://github.com/paperclipai/paperclip/pull/1",
    );
    expect(safeUpstreamUrl("https://github.com/other/repo/pull/1", "paperclipai", "paperclip", "/pull/1")).toBe(
      "https://github.com/paperclipai/paperclip/pull/1",
    );
    expect(safeUpstreamUrl(null, "paperclipai", "paperclip", "/pull/1")).toBe(
      "https://github.com/paperclipai/paperclip/pull/1",
    );
  });
});
