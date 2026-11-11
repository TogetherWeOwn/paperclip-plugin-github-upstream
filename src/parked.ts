import type { Issue } from "@paperclipai/shared";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { resolveConfig, type UpstreamConfig } from "./config.js";
import { stateKey } from "./state.js";

/**
 * Parked-blocker propagation (TWO-5818): when a card that blocks others is
 * parked — moved to `backlog` or `cancelled`, or marked NO-GO/deferred — wake
 * each blocked dependent's assignee with the parked root and its revisit
 * trigger, so the dependent is re-dispositioned instead of staying `blocked`
 * forever. The 2026-11-11 audit found 19 parked roots holding about 173
 * blocked cards while no propagation existed.
 *
 * SDK contract used (stock SDK, no core patch):
 * - `ctx.events.on("issue.updated")` — needs `events.subscribe`. This is the
 *   same event subscription as the review-guard (TWO-5794). The handler
 *   assumes no payload shape: it takes `companyId` + `entityId` from the
 *   event envelope and re-reads the issue via `ctx.issues.get`.
 * - `ctx.issues.relations.get(rootId, companyId)` — needs
 *   `issue.relations.read`. Returns `{ blockedBy, blocks }`; `blocks` is
 *   exactly the dependents to wake (each summary carries id, title, status
 *   and assignee). No other read is needed to enumerate them.
 * - `ctx.issues.requestWakeup` — needs `issues.wakeup` (already declared).
 *   Preferred when the host accepts it, but the host refuses to wake a card
 *   with unresolved blockers (the harness mirror throws "Issue is blocked by
 *   unresolved blockers" whenever any `blockedBy` entry is not `done`, and
 *   also refuses `backlog`/`done`/`cancelled` dependents). A parked root is
 *   by definition not `done`, so this call is expected to throw for every
 *   freshly parked dependent. The handler still tries it first (so an
 *   issue-scoped wake wins if the host guard ever relaxes) and falls back.
 * - `ctx.agents.invoke(agentId, companyId, { prompt, reason })` — needs
 *   `agents.invoke`. This is the fallback that actually wakes a blocked
 *   dependent's assignee: the harness/host checks only the agent's own
 *   status (paused/terminated/pending_approval), never issue status or
 *   blocker resolution. The prompt carries ONLY identifiers, statuses and
 *   the fixed re-disposition instruction — never free text from the parked
 *   root (title, description, revisit trigger). That text lives in the audit
 *   comment on the dependent card, read as card data. See B1 below.
 * - `ctx.issues.createComment` / `listComments` — needs
 *   `issue.comments.create` / `issue.comments.read`. Plugin-attributed
 *   comments never wake anyone (SDK docs), so the comment is the durable
 *   audit trail, not the wake. The wake is the step above; the comment makes
 *   the propagation visible on the dependent card.
 *
 * Security constraints (binding here, from the Security return on TWO-5794):
 * - Wake/comment only — this module never calls `issues.update`, never
 *   changes a dependent's status, assignee or stages. The only writes are
 *   the audit comment, the wake/invoke, and the plugin's own state record.
 *   A test spies on `issues.update` and fails if any call targets a
 *   dependent (Devin 0007).
 * - Dedupe per (root transition, dependent): the `windows` record keys a
 *   propagation window by root + transition (`<status>:<kind>`); each
 *   dependent is recorded once per window. A re-park (backlog -> cancelled,
 *   or a text-only NO-GO -> deferred change at the same status) opens a new
 *   window with a fresh woken set. The comment marker and the `requestWakeup`
 *   idempotency key both include (root, transition, dependent), so neither
 *   host-side nor comment-side dedupe can confuse dependents or transitions
 *   (Security B5a, Devin 0004).
 * - Wake-path dedupe after state loss: the event path checks the marker
 *   BEFORE waking; if the comment for this (root, transition, dependent)
 *   already exists, the wake is skipped (`already`). State loss therefore
 *   cannot duplicate an invoke on the event path (B5b). The sweep passes
 *   `allowWakeIfCommented=true` so entries queued AFTER a failed wake
 *   (comment posted, invoke failed) still retry the wake; overflow entries
 *   queued before any comment have no marker and proceed normally.
 * - Only `blocked` dependents are propagated (B2). A dependent in
 *   `in_review`/`in_progress`/`todo`/`backlog` is skipped — waking its
 *   assignee (for `in_review`, the reviewer) with an owner instruction would
 *   be wrong. The sweep re-validates both `status === "blocked"` and that
 *   the blocker relation still exists (Devin 0005).
 * - Terminal dependents (`done`, `cancelled`, archived) are skipped.
 *   Dependents with no agent assignee get the audit comment but no wake
 *   (a user assignee cannot be invoked).
 * - Terminal/archived roots are never parked (B3, Devin 0003): `done` or
 *   archived roots return null even when they retain a NO-GO/deferred note.
 *   Text dispositions only count for live statuses (`todo`, `in_progress`,
 *   `in_review`, `blocked`); `backlog`/`cancelled` park via status.
 * - Fan-out is bounded per event/tick by `parkedMaxWakesPerEvent`, counting
 *   ATTEMPTS (B4, Devin 0006): a failed propagate still posts a comment and
 *   consumes cap, exactly like the sweep's attempted-set cap. Overflow goes
 *   to the `pending` queue, drained by the next tick's
 *   `parked-propagation-scan` sweep (next-tick self-heal). Pending entries
 *   are re-validated (root still parked in the same transition, dependent
 *   still `blocked` and still blocked BY this root, non-terminal) and
 *   dropped after 3 attempts. Re-park invalidates pending entries for the
 *   old transition (Devin 0002).
 * - Loop-safe: the handler only fires on parked roots and only writes to
 *   dependents. Its own writes never park anything, so a dependent's update
 *   event is a cheap `not-parked` return. If a dependent is itself parked,
 *   its own events propagate from its own dedupe window — a genuine chain,
 *   bounded per root, not a self-loop.
 * - Concurrent handlers (Devin 0001): the state record is read-modify-write
 *   with no host CAS (SDK `state` exposes only get/set/delete). Writes go
 *   through `writeParkedStateConvergent`, which merges the caller's changes
 *   into the latest record (union of windows' woken sets within one
 *   transition, union of pending entries) and retries until the written
 *   entries survive a re-read (up to 3 attempts). Convergence plus the
 *   marker-guarded event wake gives: no silent loss of queued wakes, no
 *   duplicate invokes, and worst case one extra pending entry that the next
 *   sweep drops on re-validation.
 */

export type ParkedKind = "backlog" | "cancelled" | "no-go" | "deferred";

export interface ParkedRoot {
  kind: ParkedKind;
}

/** Terminal dependent statuses: never woken, never commented. */
const TERMINAL_STATUSES = new Set(["done", "cancelled"]);

/** Statuses that may carry a text NO-GO/deferred disposition (in addition to backlog/cancelled via status). */
const LIVE_TEXT_STATUSES = new Set(["todo", "in_progress", "in_review", "blocked"]);

/**
 * A card is a parked root when its status is `backlog`/`cancelled` (the
 * native "parked" states) or its title/description carries a NO-GO/deferred
 * disposition marker. The SDK exposes no execution-decision disposition to
 * read (decision outcomes are only approved/changes_requested), so the
 * text markers are: `NO-GO` / `NO GO` (word-boundaried) and `deferred`.
 * `defer` alone is deliberately not matched: "defer to X" delegates, it
 * does not park.
 *
 * Terminal/archived roots are never parked: a `done` root that retains an
 * old NO-GO note is complete, not parked, and its dependents must not be
 * woken. Archived roots likewise never park.
 */
export function isParkedRoot(
  issue: Pick<Issue, "status" | "title" | "description" | "archivedAt">,
): ParkedRoot | null {
  if (issue.status === "done") return null;
  if (issue.archivedAt != null && String(issue.archivedAt).length > 0) return null;
  if (issue.status === "backlog") return { kind: "backlog" };
  if (issue.status === "cancelled") return { kind: "cancelled" };
  if (!LIVE_TEXT_STATUSES.has(issue.status)) return null;
  const text = `${issue.title ?? ""}\n${issue.description ?? ""}`;
  if (/\bNO[-\s]?GO\b/i.test(text)) return { kind: "no-go" };
  if (/\bdeferred\b/i.test(text)) return { kind: "deferred" };
  return null;
}

const CONTROL_OR_DEL = (ch: string): boolean => {
  const code = ch.charCodeAt(0);
  return code < 32 || code === 127;
};

const singleLine = (text: string, maxLength = 200): string => {
  const flat = [...text].map((ch) => (CONTROL_OR_DEL(ch) ? " " : ch)).join("");
  const collapsed = flat.replace(/\s+/g, " ").trim();
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength).trimEnd()}…` : collapsed;
};

const REVISIT_RES: RegExp[] = [
  /\brevisit(?:ation)?(?:\s+(?:on|when|by))?\s*[:\-–—]?\s*(.+)/i,
  /\bunblocks?\s+when\s+(.+)/i,
  /\bcheckpoint\s*:\s*(.+)/i,
  /\breview(?:ed)?\s+(?:on|by)\s+(.+)/i,
];

/** Lines that name the revisit trigger win, then the monitor schedule, then the unblock descriptor. */
export function extractRevisitTrigger(
  issue: Pick<Issue, "description" | "monitorNextCheckAt" | "unblockDescriptor">,
): string | null {
  const description = issue.description ?? "";
  for (const line of description.split("\n")) {
    for (const re of REVISIT_RES) {
      const match = re.exec(line.trim());
      if (match?.[1]?.trim()) return singleLine(match[1]);
    }
  }
  if (issue.monitorNextCheckAt) {
    return singleLine(`monitor check scheduled at ${new Date(issue.monitorNextCheckAt).toISOString()}`);
  }
  if (issue.unblockDescriptor?.action) {
    return singleLine(`unblock action: ${issue.unblockDescriptor.action}`);
  }
  return null;
}

export interface ParkedReason {
  /** Structured, human-readable reason (comment body first line). NEVER sent as an agent prompt. */
  headline: string;
  /** Full comment body, including the loop-safety marker. */
  body: string;
  /** Marker embedded in every propagation comment; `listComments` checks for it. */
  marker: string;
  /** Idempotency key for `requestWakeup`: (root, transition, dependent). */
  idempotencyKey: string;
  /** Transition key `"<status>:<kind>"`: distinguishes windows and markers. */
  transition: string;
}

/**
 * Audit reason for the comment. The headline embeds free text from the parked
 * root and is safe ONLY as card data (comment body). It must never reach an
 * `agents.invoke` prompt/reason — see {@link buildSafeInvokeReason} and
 * {@link buildSafeInvokePrompt}.
 */
export function buildParkedReason(
  root: Pick<Issue, "id" | "identifier" | "title" | "status">,
  parkedKind: ParkedKind,
  revisitTrigger: string | null,
  atIso: string,
  eventId: string | null,
  dependentId: string,
): ParkedReason {
  const ident = root.identifier ?? root.id;
  const title = singleLine(root.title ?? "", 120);
  const transition = `${root.status}:${parkedKind}`;
  const headline =
    `Parked blocker: ${ident} (${transition})` +
    (title ? ` — "${title}"` : "") +
    ` — revisit: ${revisitTrigger ?? "none recorded on the parked root"}`;
  const marker = `<!-- parked-blocker: rootId=${root.id} transition=${transition} dependentId=${dependentId} -->`;
  const body = [
    marker,
    headline,
    "",
    "This dependent is blocked by the parked root above, which will not unblock it until re-dispositioned. " +
      "Re-disposition this card (defer, re-scope, or request an unblock) instead of waiting on the parked root.",
    "",
    `Source: togetherweown.github-upstream parked-blocker propagation (TWO-5818)` +
      (eventId ? `, event ${eventId}` : "") +
      `, at ${atIso}. Wake/comment only: the plugin changed no status, assignee or stage.`,
  ].join("\n");
  return {
    headline,
    body,
    marker,
    idempotencyKey: `parked:${root.id}:${transition}:${dependentId}`,
    transition,
  };
}

/**
 * Safe reason for `requestWakeup` / `agents.invoke`: identifiers and
 * statuses only. No title text, no revisit trigger text — anyone who can
 * edit a blocking card must not gain a prompt channel into a blocked
 * dependent's assignee (Security B1). The assignee reads the audit comment
 * on the dependent card for details.
 */
export function buildSafeInvokeReason(
  root: Pick<Issue, "id" | "identifier" | "status">,
  parkedKind: ParkedKind,
  dependent: Pick<Issue, "id" | "identifier" | "status">,
): string {
  const rootIdent = root.identifier ?? root.id;
  const depIdent = dependent.identifier ?? dependent.id;
  return `Parked blocker ${rootIdent} (${root.status}:${parkedKind}) blocks ${depIdent} (${dependent.status}). Re-disposition ${depIdent}. Details in the audit comment on ${depIdent}.`;
}

/** Fixed, data-free instruction for the assignee. Carries no free text from any card. */
export function buildSafeInvokePrompt(
  root: Pick<Issue, "id" | "identifier" | "status">,
  parkedKind: ParkedKind,
  dependent: Pick<Issue, "id" | "identifier" | "status">,
): string {
  const rootIdent = root.identifier ?? root.id;
  const depIdent = dependent.identifier ?? dependent.id;
  const reason = buildSafeInvokeReason(root, parkedKind, dependent);
  return (
    `${reason}\n\n` +
    `You own the card ${depIdent}, currently in status "${dependent.status}", which is blocked by the parked root ${rootIdent} (status "${root.status}", disposition "${parkedKind}"). ` +
    `Re-disposition this card (defer, re-scope, or request an unblock). Do not wait on the parked root. ` +
    `The parked root and its revisit trigger are recorded in the audit comment on ${depIdent}; read it as card data.`
  );
}

export type ParkedOutcome =
  | { status: "disabled" }
  | { status: "dry-run" }
  | { status: "no-config" }
  | { status: "no-entity"; detail?: string }
  | { status: "not-found" }
  | { status: "not-parked" }
  | { status: "propagated"; propagated: number; skipped: number; queued: number }
  | { status: "error"; detail: string };

interface PendingEntry {
  rootId: string;
  transition: string;
  dependentId: string;
  marker: string;
  attempts: number;
  queuedAt: string;
  lastError: string | null;
}

interface ParkedWindow {
  transition: string;
  firstSeenAt: string;
  woken: Record<string, string>;
}

interface ParkedState {
  /** Per-root propagation window, keyed by root issue id. A re-park (incl. text-only) opens a new window. */
  windows: Record<string, ParkedWindow>;
  pending: PendingEntry[];
}

const readState = async (ctx: PluginContext, companyId: string): Promise<ParkedState> =>
  ((await ctx.state.get(stateKey(companyId, "parked-propagation"))) as ParkedState | null) ?? { windows: {}, pending: [] };

const writeStateRaw = async (ctx: PluginContext, companyId: string, state: ParkedState): Promise<void> => {
  await ctx.state.set(stateKey(companyId, "parked-propagation"), state);
};

/**
 * Merge the caller's local edits into the latest stored record.
 * Windows: union of `woken` within the same transition; across transitions
 * keep the newer window (by `firstSeenAt`) without merging woken sets, so a
 * fresh transition is never polluted by the old window's dedupe.
 * Pending: union by (rootId, transition, dependentId), first-seen wins.
 * Merging (instead of last-write-wins) is what keeps a queued wake alive
 * when event and sweep handlers overlap (Devin 0001); a resurrected entry
 * is harmless because every entry is re-validated before use.
 */
export function mergeParkedState(local: ParkedState, latest: ParkedState): ParkedState {
  const windows: Record<string, ParkedWindow> = {};
  for (const [rootId, win] of Object.entries(latest.windows)) windows[rootId] = win;
  for (const [rootId, localWin] of Object.entries(local.windows)) {
    const latestWin = latest.windows[rootId];
    if (!latestWin) {
      windows[rootId] = localWin;
      continue;
    }
    if (localWin.transition === latestWin.transition) {
      windows[rootId] = {
        transition: latestWin.transition,
        firstSeenAt: latestWin.firstSeenAt < localWin.firstSeenAt ? latestWin.firstSeenAt : localWin.firstSeenAt,
        woken: { ...latestWin.woken, ...localWin.woken },
      };
    } else {
      windows[rootId] = localWin.firstSeenAt > latestWin.firstSeenAt ? localWin : latestWin;
    }
  }
  const pendingByKey = new Map<string, PendingEntry>();
  for (const entry of [...latest.pending, ...local.pending]) {
    const key = `${entry.rootId}:${entry.transition}:${entry.dependentId}`;
    if (!pendingByKey.has(key)) pendingByKey.set(key, entry);
  }
  return { windows, pending: [...pendingByKey.values()] };
}

/**
 * Convergent write: re-read, merge, write, and verify the written entries
 * survived (a concurrent writer may have landed between our read and
 * write). Retries up to 3 times; on persistent divergence the last merged
 * write is left for the next tick's self-heal. Exported for tests to prove
 * the merge keeps both handlers' entries.
 */
export async function writeParkedStateConvergent(
  ctx: PluginContext,
  companyId: string,
  local: ParkedState,
): Promise<ParkedState> {
  let current = local;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const latest = await readState(ctx, companyId);
    const merged = mergeParkedState(current, latest);
    await writeStateRaw(ctx, companyId, merged);
    const verify = await readState(ctx, companyId);
    const hasAllWindows = Object.keys(merged.windows).every((rootId) => {
      const want = merged.windows[rootId];
      const got = verify.windows[rootId];
      if (!got) return false;
      if (got.transition !== want.transition) return false;
      return Object.keys(want.woken).every((dep) => got.woken[dep] !== undefined);
    });
    const hasAllPending = merged.pending.every((e) =>
      verify.pending.some((p) => p.rootId === e.rootId && p.transition === e.transition && p.dependentId === e.dependentId),
    );
    if (hasAllWindows && hasAllPending) return verify;
    current = mergeParkedState(current, verify);
  }
  return readState(ctx, companyId);
}

type ParkedConfig = Pick<UpstreamConfig, "parkedPropagationEnabled" | "parkedMaxWakesPerEvent" | "dryRun">;

const loadConfig = async (ctx: PluginContext, companyId: string): Promise<ParkedConfig | null> => {
  const raw = await ctx.config.get(companyId);
  if (!raw || Object.keys(raw).length === 0) return null;
  return resolveConfig(raw);
};

function eventIssueId(event: PluginEvent): string | null {
  if (typeof event.entityId === "string" && event.entityId.length > 0) return event.entityId;
  const payload = event.payload;
  if (typeof payload === "object" && payload !== null) {
    for (const key of ["issueId", "id"]) {
      const value = (payload as Record<string, unknown>)[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return null;
}

/**
 * One dependent: audit comment + tiered wake.
 * Returns:
 * - "woke" | "invoke": wake delivered (issue wake or agent invoke).
 * - "comment-only": comment posted, no agent assignee to wake.
 * - "already": the (root, transition, dependent) marker already exists and,
 *   on the event path, the wake is intentionally skipped so state loss
 *   cannot duplicate an invoke (B5b). The sweep passes
 *   `allowWakeIfCommented=true` to retry wakes queued after a failure.
 * - "failed": transient failure; caller queues for the next tick.
 */
async function propagateToDependent(
  ctx: PluginContext,
  companyId: string,
  dependent: Issue,
  reason: ParkedReason,
  dryRun: boolean,
  safePrompt: string,
  safeReason: string,
  allowWakeIfCommented: boolean,
): Promise<{ kind: "woke" | "invoke" | "comment-only" | "already" | "failed"; error: string | null }> {
  if (dryRun) return { kind: "comment-only", error: null };
  let alreadyCommented = false;
  try {
    const existing = await ctx.issues.listComments(dependent.id, companyId);
    alreadyCommented = existing.some((c) => c.body.includes(reason.marker));
    if (!alreadyCommented) {
      await ctx.issues.createComment(dependent.id, reason.body, companyId);
    }
  } catch (err) {
    return { kind: "failed", error: String(err) };
  }
  if (alreadyCommented && !allowWakeIfCommented) {
    return { kind: "already", error: null };
  }
  const agentId = dependent.assigneeAgentId;
  if (!agentId) return { kind: "comment-only", error: null };
  try {
    const result = await ctx.issues.requestWakeup(dependent.id, companyId, {
      reason: safeReason,
      idempotencyKey: reason.idempotencyKey,
    });
    if (result.queued === false) throw new Error("wakeup not queued");
    return { kind: "woke", error: null };
  } catch {
    // Expected for freshly parked dependents (unresolved blockers refuse the
    // issue wake). Fall back to invoking the assignee directly with the
    // safe, data-free prompt — never the headline.
    try {
      await ctx.agents.invoke(agentId, companyId, { prompt: safePrompt, reason: safeReason });
      return { kind: "invoke", error: null };
    } catch (err) {
      return { kind: "failed", error: String(err) };
    }
  }
}

const isTerminal = (issue: Pick<Issue, "status" | "archivedAt">): boolean =>
  TERMINAL_STATUSES.has(issue.status) || (issue.archivedAt != null && String(issue.archivedAt).length > 0);

/**
 * `issue.updated` handler: if the event entity is a parked root with blocked
 * dependents, comment + wake each `blocked` dependent (bounded fan-out,
 * overflow queued). Never throws for a legitimate no-op; per-dependent
 * failures are queued for the sweep instead of failing the event.
 */
export async function handleParkedEvent(
  ctx: PluginContext,
  event: PluginEvent,
  now: () => number = Date.now,
): Promise<ParkedOutcome> {
  const companyId = event.companyId;
  const config = await loadConfig(ctx, companyId);
  if (!config) return { status: "no-config" };
  if (!config.parkedPropagationEnabled) return { status: "disabled" };
  const rootId = eventIssueId(event);
  if (!rootId) return { status: "no-entity" };
  const root = await ctx.issues.get(rootId, companyId);
  if (!root) return { status: "not-found" };
  const parked = isParkedRoot(root);
  const state = await readState(ctx, companyId);
  if (!parked) {
    // Unparked root: close its window so a future park is a fresh transition.
    if (state.windows[rootId]) {
      delete state.windows[rootId];
      state.pending = state.pending.filter((p) => p.rootId !== rootId);
      await writeParkedStateConvergent(ctx, companyId, state);
    }
    return { status: "not-parked" };
  }
  if (config.dryRun) {
    ctx.logger.info("parked-blocker propagation dry-run: would propagate", { companyId, rootId, status: root.status });
    return { status: "dry-run" };
  }

  const nowMs = now();
  const atIso = new Date(nowMs).toISOString();
  const transition = `${root.status}:${parked.kind}`;
  let window = state.windows[rootId];
  if (!window || window.transition !== transition) {
    window = { transition, firstSeenAt: atIso, woken: {} };
    state.windows[rootId] = window;
    // A new transition supersedes pending entries queued for the previous
    // parked transition (Devin 0002): they would be dropped by the sweep
    // on transition mismatch anyway, and still-queued dependents are
    // re-propagated by this event under the new window instead of being
    // skipped via pendingIds.
    state.pending = state.pending.filter((p) => p.rootId !== rootId || p.transition === transition);
  }
  const pendingIds = new Set(state.pending.filter((p) => p.rootId === rootId).map((p) => p.dependentId));

  let blocks: { id: string; status: string }[];
  try {
    const relations = await ctx.issues.relations.get(rootId, companyId);
    blocks = relations.blocks;
  } catch (err) {
    await writeParkedStateConvergent(ctx, companyId, state);
    return { status: "error", detail: String(err) };
  }

  const trigger = extractRevisitTrigger(root);
  const cap = config.parkedMaxWakesPerEvent;
  let propagated = 0;
  let skipped = 0;
  let queued = 0;
  // Attempts count against the cap (B4): a failed propagate still posted a
  // comment, exactly like the sweep's attempted-set cap.
  let attempted = 0;

  for (const summary of blocks) {
    if (TERMINAL_STATUSES.has(summary.status)) {
      skipped += 1;
      continue;
    }
    // Only `blocked` dependents are woken (B2): in_review/in_progress/todo/
    // backlog dependents have a different assignee role or disposition and
    // must not receive an owner re-disposition wake.
    if (summary.status !== "blocked") {
      skipped += 1;
      continue;
    }
    if (window.woken[summary.id] !== undefined || pendingIds.has(summary.id)) {
      skipped += 1;
      continue;
    }
    if (attempted >= cap) {
      const reasonForPending = buildParkedReason(root, parked.kind, trigger, atIso, event.eventId ?? null, summary.id);
      state.pending.push({ rootId, transition, dependentId: summary.id, marker: reasonForPending.marker, attempts: 0, queuedAt: atIso, lastError: null });
      queued += 1;
      continue;
    }
    const dependent = await ctx.issues.get(summary.id, companyId);
    if (!dependent || isTerminal(dependent) || dependent.status !== "blocked") {
      skipped += 1;
      continue;
    }
    const reason = buildParkedReason(root, parked.kind, trigger, atIso, event.eventId ?? null, dependent.id);
    const safePrompt = buildSafeInvokePrompt(root, parked.kind, dependent);
    const safeReason = buildSafeInvokeReason(root, parked.kind, dependent);
    const result = await propagateToDependent(ctx, companyId, dependent, reason, false, safePrompt, safeReason, false);
    if (result.kind === "failed") {
      state.pending.push({ rootId, transition, dependentId: summary.id, marker: reason.marker, attempts: 1, queuedAt: atIso, lastError: result.error });
      queued += 1;
      attempted += 1;
      continue;
    }
    if (result.kind === "already") {
      // State loss / retry: marker already on the card, wake skipped (B5b).
      window.woken[summary.id] = "already";
      continue;
    }
    window.woken[summary.id] = result.kind;
    propagated += 1;
    attempted += 1;
  }

  await writeParkedStateConvergent(ctx, companyId, state);
  if (propagated > 0 || queued > 0) {
    ctx.logger.info("parked-blocker propagation", { companyId, rootId, status: root.status, propagated, skipped, queued });
  }
  return { status: "propagated", propagated, skipped, queued };
}

/**
 * Next-tick self-heal: drain the pending queue (fan-out overflow and
 * transient wake failures). Every entry is re-validated — the root must
 * still be parked in the same transition, the dependent must still be
 * `blocked`, non-terminal and still blocked BY this root (Devin 0005) —
 * before a wake is attempted. Entries that exhaust 3 attempts are dropped
 * (logged); their comment stands as the audit trail, and a later event for
 * the root re-queues them.
 */
export async function runParkedSweep(
  ctx: PluginContext,
  companyId: string,
  config: ParkedConfig,
): Promise<{ drained: number; dropped: number; remaining: number }> {
  const state = await readState(ctx, companyId);
  if (state.pending.length === 0) return { drained: 0, dropped: 0, remaining: 0 };
  if (!config.parkedPropagationEnabled || config.dryRun) return { drained: 0, dropped: 0, remaining: state.pending.length };

  const nowMs = Date.now();
  const atIso = new Date(nowMs).toISOString();
  const cap = config.parkedMaxWakesPerEvent;
  const attempted = new Set<string>();
  let drained = 0;
  let dropped = 0;
  const remaining: PendingEntry[] = [];

  for (const entry of state.pending) {
    const key = `${entry.rootId}:${entry.transition}:${entry.dependentId}`;
    if (attempted.size >= cap) {
      remaining.push(entry);
      continue;
    }
    attempted.add(key);
    const root = await ctx.issues.get(entry.rootId, companyId);
    const parked = root ? isParkedRoot(root) : null;
    if (!root || !parked) {
      dropped += 1;
      continue;
    }
    if (`${root.status}:${parked.kind}` !== entry.transition) {
      dropped += 1;
      continue;
    }
    const window = state.windows[entry.rootId];
    if (window?.transition === entry.transition && window.woken[entry.dependentId] !== undefined) {
      dropped += 1;
      continue;
    }
    const dependent = await ctx.issues.get(entry.dependentId, companyId);
    if (!dependent || isTerminal(dependent) || dependent.status !== "blocked") {
      dropped += 1;
      continue;
    }
    // Re-check the blocker relation (Devin 0005): a removed blocker drops
    // the entry instead of waking an agent that is no longer blocked.
    try {
      const relations = await ctx.issues.relations.get(entry.rootId, companyId);
      if (!relations.blocks.some((b) => b.id === entry.dependentId)) {
        dropped += 1;
        continue;
      }
    } catch {
      remaining.push(entry);
      continue;
    }
    const trigger = extractRevisitTrigger(root);
    const reason = buildParkedReason(root, parked.kind, trigger, atIso, null, dependent.id);
    const safePrompt = buildSafeInvokePrompt(root, parked.kind, dependent);
    const safeReason = buildSafeInvokeReason(root, parked.kind, dependent);
    const result = await propagateToDependent(ctx, companyId, dependent, reason, false, safePrompt, safeReason, true);
    if (result.kind === "failed") {
      const attempts = entry.attempts + 1;
      if (attempts >= 3) {
        ctx.logger.info("parked-blocker propagation giving up on dependent", { companyId, rootId: entry.rootId, dependentId: entry.dependentId, error: entry.lastError });
        dropped += 1;
      } else {
        remaining.push({ ...entry, attempts, lastError: result.error });
      }
      continue;
    }
    const existingWindow = state.windows[entry.rootId];
    if (existingWindow && existingWindow.transition === entry.transition) {
      existingWindow.woken[entry.dependentId] = result.kind;
    } else {
      state.windows[entry.rootId] = { transition: entry.transition, firstSeenAt: atIso, woken: { [entry.dependentId]: result.kind } };
    }
    drained += 1;
  }

  state.pending = remaining;
  await writeParkedStateConvergent(ctx, companyId, state);
  return { drained, dropped, remaining: remaining.length };
}
