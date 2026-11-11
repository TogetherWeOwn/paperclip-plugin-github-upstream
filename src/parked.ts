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
 *   blocker resolution. The prompt carries the parked root and its revisit
 *   trigger plus a re-disposition instruction.
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
 * - Dedupe per (root transition, dependent): the `windows` record below
 *   keys a propagation window by root + parked status; each dependent is
 *   recorded once per window. A re-park (backlog -> cancelled, or vice
 *   versa) opens a new window.
 * - Terminal dependents (`done`, `cancelled`) are skipped; `archivedAt`
 *   dependents are skipped too. Dependents with no agent assignee get the
 *   audit comment but no wake (a user assignee cannot be invoked).
 * - Fan-out is bounded per event/tick by `parkedMaxWakesPerEvent`; the
 *   overflow goes to the `pending` queue, drained by the next tick's
 *   `parked-propagation-scan` sweep (next-tick self-heal). Pending entries
 *   are re-validated (root still parked, dependent still non-terminal) and
 *   dropped after 3 attempts.
 * - Loop-safe: the handler only fires on parked roots and only writes to
 *   dependents. Its own writes never park anything, so a dependent's update
 *   event is a cheap `not-parked` return. If a dependent is itself parked,
 *   its own events propagate from its own dedupe window — a genuine chain,
 *   bounded per root, not a self-loop. Each propagation comment carries an
 *   HTML marker checked via `listComments` before posting, so a retried
 *   wake never duplicates the comment even if plugin state is lost.
 * - Read-modify-write limit (same as the review-guard): concurrent event +
 *   sweep handlers for one company can both read the state record; the last
 *   write wins. The per-dependent comment marker plus the idempotency key
 *   on `requestWakeup` keep the externally visible effects idempotent.
 */

export type ParkedKind = "backlog" | "cancelled" | "no-go" | "deferred";

export interface ParkedRoot {
  kind: ParkedKind;
}

/** Terminal dependent statuses: never woken, never commented. */
const TERMINAL_STATUSES = new Set(["done", "cancelled"]);

/**
 * A card is a parked root when its status is `backlog`/`cancelled` (the
 * native "parked" states) or its title/description carries a NO-GO/deferred
 * disposition marker. The SDK exposes no execution-decision disposition to
 * read (decision outcomes are only approved/changes_requested), so the
 * text markers are: `NO-GO` / `NO GO` (word-boundaried) and `deferred`.
 * `defer` alone is deliberately not matched: "defer to X" delegates, it
 * does not park.
 */
export function isParkedRoot(issue: Pick<Issue, "status" | "title" | "description">): ParkedRoot | null {
  if (issue.status === "backlog") return { kind: "backlog" };
  if (issue.status === "cancelled") return { kind: "cancelled" };
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
  /** Structured, human-readable reason (comment body first line + wake reason). */
  headline: string;
  /** Full comment body, including the loop-safety marker. */
  body: string;
  /** Marker embedded in every propagation comment; `listComments` checks for it. */
  marker: string;
  /** Idempotency key for `requestWakeup`. */
  idempotencyKey: string;
}

export function buildParkedReason(
  root: Pick<Issue, "id" | "identifier" | "title" | "status">,
  parkedKind: ParkedKind,
  revisitTrigger: string | null,
  atIso: string,
  eventId: string | null,
): ParkedReason {
  const ident = root.identifier ?? root.id;
  const title = singleLine(root.title ?? "", 120);
  const headline =
    `Parked blocker: ${ident} (${root.status}${parkedKind === "backlog" || parkedKind === "cancelled" ? "" : `, ${parkedKind}`})` +
    (title ? ` — "${title}"` : "") +
    ` — revisit: ${revisitTrigger ?? "none recorded on the parked root"}`;
  const marker = `<!-- parked-blocker: rootId=${root.id} status=${root.status} -->`;
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
    idempotencyKey: `parked:${root.id}:${root.status}`,
  };
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
  rootStatus: string;
  dependentId: string;
  marker: string;
  attempts: number;
  queuedAt: string;
  lastError: string | null;
}

interface ParkedState {
  /** Per-root propagation window, keyed by root issue id. A re-park opens a new window. */
  windows: Record<string, { status: string; firstSeenAt: string; woken: Record<string, string> }>;
  pending: PendingEntry[];
}

const readState = async (ctx: PluginContext, companyId: string): Promise<ParkedState> =>
  ((await ctx.state.get(stateKey(companyId, "parked-propagation"))) as ParkedState | null) ?? { windows: {}, pending: [] };

const writeState = async (ctx: PluginContext, companyId: string, state: ParkedState): Promise<void> => {
  await ctx.state.set(stateKey(companyId, "parked-propagation"), state);
};

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
 * One dependent: audit comment (once per window, marker-guarded) + tiered
 * wake. Returns "woke" | "invoke" | "comment-only" (no agent assignee) |
 * "failed" (transient; caller queues for the next tick).
 */
async function propagateToDependent(
  ctx: PluginContext,
  companyId: string,
  dependent: Issue,
  reason: ParkedReason,
  dryRun: boolean,
): Promise<{ kind: "woke" | "invoke" | "comment-only" | "failed"; error: string | null }> {
  if (dryRun) return { kind: "comment-only", error: null };
  try {
    const existing = await ctx.issues.listComments(dependent.id, companyId);
    if (!existing.some((c) => c.body.includes(reason.marker))) {
      await ctx.issues.createComment(dependent.id, reason.body, companyId);
    }
  } catch (err) {
    return { kind: "failed", error: String(err) };
  }
  const agentId = dependent.assigneeAgentId;
  if (!agentId) return { kind: "comment-only", error: null };
  try {
    const result = await ctx.issues.requestWakeup(dependent.id, companyId, {
      reason: reason.headline,
      idempotencyKey: reason.idempotencyKey,
    });
    if (result.queued === false) throw new Error("wakeup not queued");
    return { kind: "woke", error: null };
  } catch {
    // Expected for freshly parked dependents (unresolved blockers refuse the
    // issue wake). Fall back to invoking the assignee directly.
    try {
      const prompt =
        `${reason.headline}\n\n` +
        `You own the card ${dependent.identifier ?? dependent.id} ("${singleLine(dependent.title ?? "", 120)}"), blocked by the parked root above. ` +
        `Re-disposition this card (defer, re-scope, or request an unblock). Do not wait on the parked root. ` +
        `The revisit trigger is: ${reason.headline.includes("revisit: none recorded") ? "none recorded" : "see reason above"}.`;
      await ctx.agents.invoke(agentId, companyId, { prompt, reason: reason.headline });
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
 * dependents, comment + wake each non-terminal dependent (bounded fan-out,
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
      await writeState(ctx, companyId, state);
    }
    return { status: "not-parked" };
  }
  if (config.dryRun) {
    ctx.logger.info("parked-blocker propagation dry-run: would propagate", { companyId, rootId, status: root.status });
    return { status: "dry-run" };
  }

  const nowMs = now();
  const atIso = new Date(nowMs).toISOString();
  let window = state.windows[rootId];
  if (!window || window.status !== root.status) {
    window = { status: root.status, firstSeenAt: atIso, woken: {} };
    state.windows[rootId] = window;
  }
  const pendingIds = new Set(state.pending.filter((p) => p.rootId === rootId).map((p) => p.dependentId));

  let blocks: { id: string; status: string }[];
  try {
    const relations = await ctx.issues.relations.get(rootId, companyId);
    blocks = relations.blocks;
  } catch (err) {
    await writeState(ctx, companyId, state);
    return { status: "error", detail: String(err) };
  }

  const trigger = extractRevisitTrigger(root);
  const reason = buildParkedReason(root, parked.kind, trigger, atIso, event.eventId ?? null);
  const cap = config.parkedMaxWakesPerEvent;
  let propagated = 0;
  let skipped = 0;
  let queued = 0;

  for (const summary of blocks) {
    if (TERMINAL_STATUSES.has(summary.status)) {
      skipped += 1;
      continue;
    }
    if (window.woken[summary.id] !== undefined || pendingIds.has(summary.id)) {
      skipped += 1;
      continue;
    }
    if (propagated >= cap) {
      state.pending.push({ rootId, rootStatus: root.status, dependentId: summary.id, marker: reason.marker, attempts: 0, queuedAt: atIso, lastError: null });
      queued += 1;
      continue;
    }
    const dependent = await ctx.issues.get(summary.id, companyId);
    if (!dependent || isTerminal(dependent)) {
      skipped += 1;
      continue;
    }
    const result = await propagateToDependent(ctx, companyId, dependent, reason, false);
    if (result.kind === "failed") {
      state.pending.push({ rootId, rootStatus: root.status, dependentId: summary.id, marker: reason.marker, attempts: 1, queuedAt: atIso, lastError: result.error });
      queued += 1;
      continue;
    }
    window.woken[summary.id] = result.kind;
    propagated += 1;
  }

  await writeState(ctx, companyId, state);
  if (propagated > 0 || queued > 0) {
    ctx.logger.info("parked-blocker propagation", { companyId, rootId, status: root.status, propagated, skipped, queued });
  }
  return { status: "propagated", propagated, skipped, queued };
}

/**
 * Next-tick self-heal: drain the pending queue (fan-out overflow and
 * transient wake failures). Every entry is re-validated — the root must
 * still be parked in the same status and the dependent non-terminal —
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
    const key = `${entry.rootId}:${entry.dependentId}`;
    if (attempted.size >= cap) {
      remaining.push(entry);
      continue;
    }
    attempted.add(key);
    const root = await ctx.issues.get(entry.rootId, companyId);
    const parked = root ? isParkedRoot(root) : null;
    if (!root || !parked || root.status !== entry.rootStatus) {
      dropped += 1;
      state.pending = state.pending.filter((p) => p.rootId !== entry.rootId);
      continue;
    }
    const window = state.windows[entry.rootId];
    if (window?.woken[entry.dependentId] !== undefined) {
      dropped += 1;
      continue;
    }
    const dependent = await ctx.issues.get(entry.dependentId, companyId);
    if (!dependent || isTerminal(dependent)) {
      dropped += 1;
      continue;
    }
    const trigger = extractRevisitTrigger(root);
    const reason = buildParkedReason(root, parked.kind, trigger, atIso, null);
    const result = await propagateToDependent(ctx, companyId, dependent, reason, false);
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
    if (state.windows[entry.rootId]) {
      state.windows[entry.rootId].woken[entry.dependentId] = result.kind;
    } else {
      state.windows[entry.rootId] = { status: root.status, firstSeenAt: atIso, woken: { [entry.dependentId]: result.kind } };
    }
    drained += 1;
  }

  state.pending = remaining;
  await writeState(ctx, companyId, state);
  return { drained, dropped, remaining: remaining.length };
}
