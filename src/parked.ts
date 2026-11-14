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
 * - Dedupe per (root transition occurrence, dependent): the `windows`
 *   record keys a propagation window by root + transition occurrence
 *   (`<status>:<kind>@<occurrenceId>`); each dependent is recorded once
 *   per window. The occurrence id is minted from the parked root's
 *   `updatedAt` at window creation and then STORED in the window: while
 *   the root stays in the same `(status:kind)` park the window (and its
 *   occurrence) is reused, so an ordinary edit (a title typo) never
 *   opens a fresh window or re-wakes dependents (Devin 0001-new). An
 *   unpark/re-park cycle (backlog -> todo -> backlog, R2-2) closes the
 *   window, so the next park mints a fresh occurrence with fresh
 *   markers and idempotency keys; a state-loss retry of the same
 *   continuous park (no intervening edit) regenerates the identical
 *   occurrence and therefore the identical markers. A re-park
 *   (backlog -> cancelled, a text-only NO-GO -> deferred change at the
 *   same status, or an unpark/re-park cycle) opens a new window with a
 *   fresh woken set. The comment markers and the `requestWakeup`
 *   idempotency key all include (root, transition occurrence,
 *   dependent), so neither host-side nor comment-side dedupe can
 *   confuse dependents, transitions or occurrences (Security B5a,
 *   Devin 0004, R2-2). Known residual: plugin state loss plus an
 *   intervening ordinary edit of the parked root (two faults) can
 *   mint a fresh occurrence and duplicate one round of wakes — the
 *   duplicate wake is a safe, idempotent re-disposition instruction,
 *   never a state mutation.
 * - Wake ordering and delivery evidence (R2-2 + Devin 0002-new):
 *   the audit comment (root + revisit trigger, read as card data) is
 *   posted BEFORE any wake, so a promptly-running assignee finds the
 *   promised context on the dependent card. The audit comment alone
 *   is NOT wake-delivery evidence. A separate delivery marker
 *   (`parked-blocker-delivered`) is posted only AFTER a successful
 *   wake, and only it short-circuits a later wake as `already`, so a
 *   failed wake followed by state loss remains retryable (no silent
 *   loss), while a successful wake followed by state loss is
 *   recognised by the delivery marker and is not duplicated (B5b).
 *   Comment-only dependents (no agent assignee) get the single audit
 *   comment. Known narrow double-fault: a wake that succeeds but
 *   whose delivery-marker write then fails leaves no delivery
 *   marker, so a later retry may duplicate that one wake — the
 *   window `woken` set prevents this whenever plugin state survives.
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
 * - Disabled housekeeping (missed-unpark fix): the `disabled` return
 *   is NOT state-free. While `parkedPropagationEnabled` is off, the
 *   handler still reads the root and, when the root is no longer
 *   parked or its (status:kind) no longer matches the window's
 *   transition (a kind change is a new park on the enabled path),
 *   closes its window (and drops its pending entries) — with
 *   no wakes and no comments. Without this, an unpark + re-park at
 *   the same `(status:kind)` while disabled left the old window (and
 *   its `woken` set) in place, and the re-park after re-enabling
 *   was skipped as an already-propagated continuous park: dependents
 *   were never woken for the genuinely new park. A root that is
 *   still parked while disabled keeps its window, so a disable/enable
 *   cycle around an ordinary edit still does not re-wake (the
 *   ordinary-edit no-re-wake invariant). Known residual: an unpark
 *   event that is never delivered to any handler at all (not merely
 *   delivered while disabled) is indistinguishable from an ordinary
 *   edit at the next parked event — no status history is readable —
 *   so the old window is still reused there. Fail direction is
 *   under-waking only: never a spurious wake, mutation, or injection.
 * - Concurrent handlers (Devin 0001, R2-1): the state record is
 *   read-modify-write with no host CAS (SDK `state` exposes only
 *   get/set/delete), and production state reads are copy-semantics (a
 *   fresh copy per `get`), so a blind union merge would resurrect
 *   deletions. Writes go through `writeParkedStateConvergent`, which
 *   applies a DELTA merge against the snapshot the handler started
 *   from (`base`): entries the handler deleted (unpark window close,
 *   drained/dropped pending) are deleted from the latest record,
 *   entries it added/modified are upserted, and entries a concurrent
 *   handler added are preserved. It retries (up to 3 attempts) until
 *   the stored record exactly matches the merged result. Delta
 *   convergence plus marker-guarded wakes gives: no silent loss of
 *   queued wakes, no resurrection of deletions, no duplicate
 *   invokes, and worst case one extra pending entry that the next
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
 * native "parked" states) or its title/description carries an EXPLICIT
 * NO-GO/deferred disposition. The SDK exposes no execution-decision
 * disposition to read (decision outcomes are only
 * approved/changes_requested), so the text must be an explicit
 * disposition, not incidental vocabulary (Q1): a label
 * (`Decision: deferred ...`, `Status: NO-GO`), a title/line prefix
 * (`NO-GO: launch`, `Deferred: ...`), a comma-listed disposition
 * (`parked, no go`), a standalone disposition line, or a predication
 * (`is deferred`, `marked no-go`). Incidental uses never park:
 * "deferred rendering/loading" (adjective + noun), "no go-to"
 * (`GO` followed by `-to`/` to` is the go-to compound, not a NO-GO),
 * and `defer` alone ("defer to X" delegates, it does not park).
 * Delegation via `deferred to X` ("deferred to the platform team" =
 * handed to X) likewise does not park.
 *
 * Title and description are checked as SEPARATE fields (TWO-5904): a
 * disposition in one field is never vetoed by the other field's first
 * word (D2: title `Deferred` + description `Execution...`), while a
 * wrapped line inside a single field stays one text — the noun veto
 * spans line breaks within a field (`deferred\nrendering` is still
 * `deferred rendering`), matching Devin's suggestion.
 *
 * Terminal/archived roots are never parked: a `done` root that retains an
 * old NO-GO note is complete, not parked, and its dependents must not be
 * woken. Archived roots likewise never park.
 */
// "deferred rendering/loading/..." is an adjective, never a disposition.
// The veto spans a SINGLE wrapped line break WITHIN one field (same-line
// whitespace `[^\S\r\n]`, incl. NBSP, or one line break plus such
// whitespace — not `\s+`): a line break inside the
// description (`deferred\nrendering`) must not escape the veto, but a
// blank line is a paragraph boundary (`Deferred\n\nExecution...` is a
// standalone disposition plus a new paragraph, so it must still park).
// Per-field checking keeps the title/description boundary separate (D2:
// title `Deferred` + description `Execution...`).
const DEFERRED_NOUN = String.raw`(?!(?:[^\S\r\n\u2028\u2029]+|[^\S\r\n\u2028\u2029]*(?:\r\n|\n|\r|\u2028|\u2029)[^\S\r\n\u2028\u2029]*)(?:rendering|loading|display|paint|execution|initialization)\b)`;
// "no go-to" / "no go to ..." is the go-to compound, never a NO-GO.
// The lookahead permits GO followed by a separator that is not `to`.
// Explicit dispositions (label, line prefix, comma list) use a
// same-line-only separator: a following line's sentence-initial
// "To ..." (`Decision: NO-GO\nTo revisit...`) is a new sentence, not
// the go-to compound, so it must not veto them. The incidental
// predication (`is no go`) keeps the wrapped-line separator, so a
// hard wrap inside the compound (`There is no go\nTo maintainer`)
// is still vetoed. Per-field checking additionally keeps the
// title/description boundary separate (D2: title `NO-GO` +
// description `To revisit...` must not veto).
const NO_GO_NOT_GOTO = String.raw`(?![ \t\-]?to\b)`;
const NO_GO_NOT_GOTO_WRAP = String.raw`(?!(?:[ \t\-]?|[^\S\r\n\u2028\u2029]*(?:\r\n|\n|\r)[^\S\r\n\u2028\u2029]*)to\b)`;

const NO_GO_RES: RegExp[] = [
  new RegExp(String.raw`\b(?:status|disposition|decision|state|outcome|parked)\s*[:=]\s*NO[-\s]?GO\b${NO_GO_NOT_GOTO}`, "i"),
  // Line prefix: punctuation/EOL or explicit continuation (D1: `NO-GO for launch`).
  new RegExp(String.raw`(?:^|\n)[ \t]*NO[-\s]?GO\b${NO_GO_NOT_GOTO}(?:[ \t]*(?:[:\-–—]|\.)|[ \t]+(?:for|on|until|because|pending)\b|[ \t]*$)`, "im"),
  new RegExp(String.raw`,\s*NO[-\s]?GO\b${NO_GO_NOT_GOTO}(?:\s+(?:for|on|until|because)\b|\s*(?:$|[.,;:!?)\]]|\n))`, "im"),
  new RegExp(String.raw`\b(?:is|was|remains?|marked|set to)\s+NO[-\s]?GO\b${NO_GO_NOT_GOTO_WRAP}`, "i"),
];

const DEFERRED_RES: RegExp[] = [
  // D3: an explicit Decision:/Status: label wins over the incidental-adjective
  // exclusion, so no DEFERRED_NOUN veto here (`Decision: deferred execution until Q3` parks).
  new RegExp(String.raw`\b(?:status|disposition|decision|state|outcome|parked)\s*[:=]\s*deferred\b`, "i"),
  // Line prefix: punctuation/EOL or explicit continuation (D1: `Deferred until Q3`).
  // DEFERRED_NOUN still vetoes `Deferred rendering...` titles. No `to`
  // continuation: `deferred to X` delegates to X (TWO-5904:
  // `Deferred to the platform team` must not park). The explicit
  // `Decision:`/`Status:` label above still parks `deferred to ...`,
  // as an explicit disposition label wins over the delegation reading.
  new RegExp(String.raw`(?:^|\n)[ \t]*deferred\b${DEFERRED_NOUN}(?:[ \t]*(?:[:\-–—]|\.)|[ \t]+(?:until|for|on|because|pending)\b|[ \t]*$)`, "im"),
  new RegExp(String.raw`,\s*deferred\b${DEFERRED_NOUN}(?:\s+(?:until|for)\b|\s*(?:$|[.,;:!?)\]]|\n))`, "im"),
  new RegExp(String.raw`\b(?:is|was|has been|been|remains?|marked)\s+deferred\b${DEFERRED_NOUN}`, "i"),
];

export function isParkedRoot(
  issue: Pick<Issue, "status" | "title" | "description" | "archivedAt">,
): ParkedRoot | null {
  if (issue.status === "done") return null;
  if (issue.archivedAt != null && String(issue.archivedAt).length > 0) return null;
  if (issue.status === "backlog") return { kind: "backlog" };
  if (issue.status === "cancelled") return { kind: "cancelled" };
  if (!LIVE_TEXT_STATUSES.has(issue.status)) return null;
  // Per-field check (TWO-5904): a disposition in one field must not be
  // vetoed by the other field's first word (D2), while a wrapped line
  // inside one field still counts for the noun veto (Devin 4533158195).
  // Status precedes description so a title NO-GO wins over a
  // description deferred note, matching the pre-split joined-text order.
  const fields = [issue.title ?? "", issue.description ?? ""];
  for (const field of fields) {
    if (NO_GO_RES.some((re) => re.test(field))) return { kind: "no-go" };
  }
  for (const field of fields) {
    if (DEFERRED_RES.some((re) => re.test(field))) return { kind: "deferred" };
  }
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

/**
 * Occurrence id MINTED when a propagation window is opened (R2-2):
 * the root's `updatedAt` at that moment. Stable across plugin-state
 * loss when the root was not edited meanwhile (root row unchanged),
 * and distinct for any later park because the unpark/re-park cycle
 * bumps `updatedAt`. The minted id is then stored in the window and
 * reused while the park continues (Devin 0001-new) — only window
 * creation calls this. Falls back to `atIso` when the host supplies
 * no `updatedAt`.
 */
export function occurrenceIdForRoot(
  root: { updatedAt?: Date | string | null },
  atIso: string,
): string {
  const raw = root.updatedAt;
  if (raw instanceof Date) return raw.toISOString();
  if (typeof raw === "string" && raw.length > 0) return raw;
  return atIso;
}

export function transitionFor(rootStatus: string, parkedKind: ParkedKind, occurrenceId: string): string {
  return `${rootStatus}:${parkedKind}@${occurrenceId}`;
}

export interface ParkedReason {
  /** Structured, human-readable reason (comment body first line). NEVER sent as an agent prompt. */
  headline: string;
  /** Audit comment body (root + revisit trigger), posted BEFORE any wake. */
  body: string;
  /** Marker embedded in the audit comment; presence means context exists, NOT that the wake was delivered. */
  auditMarker: string;
  /** One-line delivery record body, posted only after a successful wake. */
  deliveryBody: string;
  /** Marker embedded in the delivery record; presence means the wake was delivered. */
  deliveryMarker: string;
  /** Alias of `deliveryMarker`, kept for pending entries and callers. */
  marker: string;
  /** Idempotency key for `requestWakeup`: (root, transition occurrence, dependent). */
  idempotencyKey: string;
  /** Transition key `"<status>:<kind>@<occurrenceId>"`: distinguishes windows, occurrences and markers. */
  transition: string;
  /** Durable occurrence id carried by the markers and idempotency key. */
  occurrenceId: string;
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
  occurrenceId?: string,
): ParkedReason {
  const ident = root.identifier ?? root.id;
  const title = singleLine(root.title ?? "", 120);
  const occ = occurrenceId ?? "legacy";
  const transition = transitionFor(root.status, parkedKind, occ);
  const headline =
    `Parked blocker: ${ident} (${transition})` +
    (title ? ` — "${title}"` : "") +
    ` — revisit: ${revisitTrigger ?? "none recorded on the parked root"}`;
  const auditMarker = `<!-- parked-blocker-audit: rootId=${root.id} transition=${transition} dependentId=${dependentId} -->`;
  const deliveryMarker = `<!-- parked-blocker-delivered: rootId=${root.id} transition=${transition} dependentId=${dependentId} -->`;
  const body = [
    auditMarker,
    headline,
    "",
    "This dependent is blocked by the parked root above, which will not unblock it until re-dispositioned. " +
      "Re-disposition this card (defer, re-scope, or request an unblock) instead of waiting on the parked root.",
    "",
    `Source: togetherweown.github-upstream parked-blocker propagation (TWO-5818)` +
      (eventId ? `, event ${eventId}` : "") +
      `, at ${atIso}. Wake/comment only: the plugin changed no status, assignee or stage.`,
  ].join("\n");
  const deliveryBody = `${deliveryMarker}\nParked-blocker propagation: the assignee of this card was woken for the parked blocker above (transition ${transition}).`;
  return {
    headline,
    body,
    auditMarker,
    deliveryBody,
    deliveryMarker,
    marker: deliveryMarker,
    idempotencyKey: `parked:${root.id}:${transition}:${dependentId}`,
    transition,
    occurrenceId: occ,
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
  occurrenceId: string;
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

const cloneParkedState = (state: ParkedState): ParkedState =>
  JSON.parse(JSON.stringify(state)) as ParkedState;

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

const pendingKey = (e: PendingEntry): string => `${e.rootId}:${e.transition}:${e.dependentId}`;

/**
 * Delta-merge the caller's local edits into the latest stored record,
 * computed against `base` — the snapshot the handler started from
 * (R2-1). Without `base` this is a plain union (legacy behaviour,
 * kept for the pre-R2 unit tests); production writes always pass
 * `base` so deletions are explicit:
 * - Windows present in `base` but absent in `local` are DELETED from
 *   the merged record (unpark window close). A blind union would
 *   resurrect them on copy-semantics state reads.
 * - Windows added/modified vs `base` are upserted: union of `woken`
 *   within the same transition occurrence, newer window wins across
 *   occurrences (by `firstSeenAt`), so a fresh occurrence is never
 *   polluted by the old window's dedupe.
 * - Windows unchanged vs `base` keep the latest version, preserving
 *   a concurrent handler's `woken` additions.
 * - Pending entries deleted vs `base` (drained/dropped by the sweep)
 *   are removed from the merged record; added/modified entries are
 *   upserted; concurrent additions are preserved. Merging (instead
 *   of last-write-wins) keeps a queued wake alive when event and
 *   sweep handlers overlap (Devin 0001).
 */
export function mergeParkedState(local: ParkedState, latest: ParkedState, base?: ParkedState): ParkedState {
  if (!base) {
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
          occurrenceId: localWin.occurrenceId ?? latestWin.occurrenceId,
          firstSeenAt: latestWin.firstSeenAt < localWin.firstSeenAt ? latestWin.firstSeenAt : localWin.firstSeenAt,
          woken: { ...latestWin.woken, ...localWin.woken },
        };
      } else {
        windows[rootId] = localWin.firstSeenAt > latestWin.firstSeenAt ? localWin : latestWin;
      }
    }
    const pendingByKey = new Map<string, PendingEntry>();
    for (const entry of [...latest.pending, ...local.pending]) {
      const key = pendingKey(entry);
      if (!pendingByKey.has(key)) pendingByKey.set(key, entry);
    }
    return { windows, pending: [...pendingByKey.values()] };
  }

  const windows: Record<string, ParkedWindow> = cloneParkedState({ windows: latest.windows, pending: [] }).windows;
  // Explicit deletions vs base.
  for (const rootId of Object.keys(base.windows)) {
    if (!(rootId in local.windows)) delete windows[rootId];
  }
  for (const [rootId, localWin] of Object.entries(local.windows)) {
    const baseWin = base.windows[rootId];
    const latestWin = latest.windows[rootId];
    if (!baseWin) {
      if (!latestWin) {
        windows[rootId] = cloneParkedState({ windows: { [rootId]: localWin }, pending: [] }).windows[rootId]!;
      } else if (latestWin.transition === localWin.transition) {
        windows[rootId] = {
          transition: latestWin.transition,
          occurrenceId: localWin.occurrenceId ?? latestWin.occurrenceId,
          firstSeenAt: latestWin.firstSeenAt < localWin.firstSeenAt ? latestWin.firstSeenAt : localWin.firstSeenAt,
          woken: { ...latestWin.woken, ...localWin.woken },
        };
      } else {
        windows[rootId] = localWin.firstSeenAt > latestWin.firstSeenAt ? localWin : latestWin;
      }
      continue;
    }
    if (canonical(baseWin) === canonical(localWin)) continue; // unchanged: keep latest
    // Modified vs base.
    if (!latestWin) {
      windows[rootId] = localWin;
    } else if (latestWin.transition === localWin.transition) {
      windows[rootId] = {
        transition: latestWin.transition,
        occurrenceId: localWin.occurrenceId ?? latestWin.occurrenceId,
        firstSeenAt: latestWin.firstSeenAt < localWin.firstSeenAt ? latestWin.firstSeenAt : localWin.firstSeenAt,
        woken: { ...latestWin.woken, ...localWin.woken },
      };
    } else {
      windows[rootId] = localWin.firstSeenAt >= latestWin.firstSeenAt ? localWin : latestWin;
    }
  }

  const pendingByKey = new Map<string, PendingEntry>();
  for (const entry of latest.pending) pendingByKey.set(pendingKey(entry), entry);
  const localKeys = new Set(local.pending.map(pendingKey));
  for (const entry of base.pending) {
    if (!localKeys.has(pendingKey(entry))) pendingByKey.delete(pendingKey(entry));
  }
  for (const entry of local.pending) {
    const key = pendingKey(entry);
    const baseEntry = base.pending.find((e) => pendingKey(e) === key);
    if (!baseEntry) {
      pendingByKey.set(key, entry);
    } else if (canonical(baseEntry) !== canonical(entry)) {
      pendingByKey.set(key, entry);
    }
    // Unchanged vs base: keep the latest version (concurrent attempts).
  }
  return { windows, pending: [...pendingByKey.values()] };
}

/**
 * Convergent write (R2-1): re-read, delta-merge the caller's edits
 * (vs `base`, the snapshot the handler started from) into the latest
 * record, write, and verify the stored record exactly matches the
 * merged result — including that deletions stayed deleted. Retries
 * up to 3 times, recomputing the delta against the freshest record
 * each time; on persistent divergence the last merged write is left
 * for the next tick's self-heal. Callers MUST pass the pre-mutation
 * snapshot as `base`; without it deletions cannot be distinguished
 * from "not seen" under copy-semantics reads. Exported for tests.
 */
export async function writeParkedStateConvergent(
  ctx: PluginContext,
  companyId: string,
  local: ParkedState,
  base?: ParkedState,
): Promise<ParkedState> {
  const snapshot = base ? cloneParkedState(base) : undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const latest = await readState(ctx, companyId);
    const merged = mergeParkedState(local, latest, snapshot);
    await writeStateRaw(ctx, companyId, merged);
    const verify = await readState(ctx, companyId);
    if (canonical(verify) === canonical(merged)) return verify;
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
 * One dependent (R2-2 + Devin 0002-new): audit comment FIRST, then
 * the wake, then the delivery marker. The audit comment makes the
 * parked root + revisit trigger readable before the assignee can
 * run; it is NOT delivery evidence. The delivery marker is posted
 * only after a successful wake, so its presence proves delivery and
 * its absence proves the wake still needs a retry — a failed wake
 * keeps the audit comment but no delivery marker, so the queued
 * retry (and a state-loss retry) wakes again instead of treating
 * the audit comment as proof of delivery.
 * Returns:
 * - "woke" | "invoke": wake delivered (issue wake or agent invoke),
 *   delivery marker posted (best-effort after delivery).
 * - "comment-only": audit comment ensured, no agent assignee to wake.
 * - "already": the delivery marker for this (root, transition
 *   occurrence, dependent) already exists, so the wake was already
 *   delivered; the wake is skipped so state loss cannot duplicate
 *   an invoke (B5b).
 * - "failed": comment check/write or wake failed; caller queues
 *   for the next tick.
 */
async function propagateToDependent(
  ctx: PluginContext,
  companyId: string,
  dependent: Issue,
  reason: ParkedReason,
  dryRun: boolean,
  safePrompt: string,
  safeReason: string,
  _allowWakeIfCommented?: boolean,
): Promise<{ kind: "woke" | "invoke" | "comment-only" | "already" | "failed"; error: string | null }> {
  if (dryRun) return { kind: "comment-only", error: null };
  let alreadyDelivered = false;
  let auditPresent = false;
  try {
    const existing = await ctx.issues.listComments(dependent.id, companyId);
    alreadyDelivered = existing.some((c) => c.body.includes(reason.deliveryMarker));
    auditPresent = existing.some((c) => c.body.includes(reason.auditMarker));
  } catch (err) {
    return { kind: "failed", error: String(err) };
  }
  if (alreadyDelivered) return { kind: "already", error: null };

  const agentId = dependent.assigneeAgentId;
  if (!agentId) {
    // Comment-only: the single audit comment is the whole record.
    if (auditPresent) return { kind: "comment-only", error: null };
    try {
      await ctx.issues.createComment(dependent.id, reason.body, companyId);
    } catch (err) {
      return { kind: "failed", error: String(err) };
    }
    return { kind: "comment-only", error: null };
  }

  // Audit context first: a promptly-running assignee must find the
  // parked root + revisit trigger on the card before any wake.
  if (!auditPresent) {
    try {
      await ctx.issues.createComment(dependent.id, reason.body, companyId);
    } catch (err) {
      return { kind: "failed", error: String(err) };
    }
  }

  let wakeKind: "woke" | "invoke" = "invoke";
  try {
    const result = await ctx.issues.requestWakeup(dependent.id, companyId, {
      reason: safeReason,
      idempotencyKey: reason.idempotencyKey,
    });
    if (result.queued === false) throw new Error("wakeup not queued");
    wakeKind = "woke";
  } catch {
    // Expected for freshly parked dependents (unresolved blockers refuse the
    // issue wake). Fall back to invoking the assignee directly with the
    // safe, data-free prompt — never the headline.
    try {
      await ctx.agents.invoke(agentId, companyId, { prompt: safePrompt, reason: safeReason });
      wakeKind = "invoke";
    } catch (err) {
      // No delivery marker is posted on failure, so the queued retry
      // (and a state-loss retry) will attempt the wake again even
      // though the audit comment already exists (R2-2).
      return { kind: "failed", error: String(err) };
    }
  }
  // Wake delivered: now post the delivery marker. If this write
  // fails, the wake is already delivered — report success rather
  // than queueing a duplicate wake (see header).
  try {
    await ctx.issues.createComment(dependent.id, reason.deliveryBody, companyId);
  } catch (err) {
    ctx.logger.error("parked-blocker propagation: wake delivered but delivery marker failed", {
      companyId,
      dependentId: dependent.id,
      error: String(err),
    });
  }
  return { kind: wakeKind, error: null };
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
  const rootId = eventIssueId(event);
  if (!rootId) return { status: "no-entity" };
  if (!config.parkedPropagationEnabled) {
    // Disabled housekeeping (missed-unpark fix): an unpark delivered
    // while propagation is off must still close the root's window, so
    // a later re-park — even at the same (status:kind), after
    // re-enabling — mints a fresh occurrence and wakes dependents
    // again. No wake, no comment, and no window is opened while
    // disabled: a still-parked root keeps its existing window, which
    // preserves the ordinary-edit no-re-wake invariant across a
    // disable/enable cycle with no intervening unpark. Roots with no
    // window return without reading the issue, keeping the disabled
    // path cheap for the common case.
    const state = await readState(ctx, companyId);
    if (!state.windows[rootId]) return { status: "disabled" };
    let root: Issue | null = null;
    try {
      root = await ctx.issues.get(rootId, companyId);
    } catch {
      // Fail closed: without a readable root the park state is
      // unknown, so keep the window (under-waking, never spurious).
      return { status: "disabled" };
    }
    const parked = root ? isParkedRoot(root) : null;
    // A still-parked root keeps its window UNLESS its (status:kind) no
    // longer matches the window's transition: a kind change is a new
    // park under the enabled path (backlog -> cancelled opens a fresh
    // window there), so the stale window is closed here as
    // housekeeping only. Without this, backlog -> cancelled -> backlog
    // while disabled would reuse the old backlog window on re-enable
    // and skip wakes for the genuinely new park (Devin review on
    // PR #16). Same (status:kind) keeps the ordinary-edit no-re-wake
    // invariant untouched.
    if (parked && state.windows[rootId]!.transition.startsWith(`${root!.status}:${parked.kind}@`)) {
      return { status: "disabled" };
    }
    const base = cloneParkedState(state);
    delete state.windows[rootId];
    state.pending = state.pending.filter((p) => p.rootId !== rootId);
    await writeParkedStateConvergent(ctx, companyId, state, base);
    return { status: "disabled" };
  }
  const root = await ctx.issues.get(rootId, companyId);
  if (!root) return { status: "not-found" };
  const parked = isParkedRoot(root);
  const state = await readState(ctx, companyId);
  const base = cloneParkedState(state);
  if (!parked) {
    // Unparked root: close its window so a future park is a fresh occurrence.
    // The delta write makes this deletion stick under copy-semantics reads.
    if (state.windows[rootId]) {
      delete state.windows[rootId];
      state.pending = state.pending.filter((p) => p.rootId !== rootId);
      await writeParkedStateConvergent(ctx, companyId, state, base);
    }
    return { status: "not-parked" };
  }
  if (config.dryRun) {
    ctx.logger.info("parked-blocker propagation dry-run: would propagate", { companyId, rootId, status: root.status });
    return { status: "dry-run" };
  }

  const nowMs = now();
  const atIso = new Date(nowMs).toISOString();
  const baseTransition = `${root.status}:${parked.kind}`;
  // Window reuse (Devin 0001-new): while the root stays in the same
  // (status:kind) park, the existing window — and its stored
  // occurrence — is reused, so an ordinary edit (which bumps
  // `updatedAt`) never opens a fresh window or re-wakes dependents.
  // Only a genuinely new park (no window, differing status/kind, or
  // a window closed by an unpark) mints a fresh occurrence.
  let window = state.windows[rootId];
  let occurrenceId: string;
  let transition: string;
  if (window && window.transition.startsWith(`${baseTransition}@`)) {
    occurrenceId = window.occurrenceId;
    transition = window.transition;
  } else {
    occurrenceId = occurrenceIdForRoot(root, atIso);
    transition = transitionFor(root.status, parked.kind, occurrenceId);
    window = { transition, occurrenceId, firstSeenAt: atIso, woken: {} };
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
    await writeParkedStateConvergent(ctx, companyId, state, base);
    return { status: "error", detail: String(err) };
  }

  const trigger = extractRevisitTrigger(root);
  const cap = config.parkedMaxWakesPerEvent;
  let propagated = 0;
  let skipped = 0;
  let queued = 0;
  // Attempts count against the cap (B4), exactly like the sweep's
  // attempted-set cap. A failed wake posts no delivery marker (R2-2)
  // but still consumes cap.
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
      const reasonForPending = buildParkedReason(root, parked.kind, trigger, atIso, event.eventId ?? null, summary.id, occurrenceId);
      state.pending.push({ rootId, transition, dependentId: summary.id, marker: reasonForPending.marker, attempts: 0, queuedAt: atIso, lastError: null });
      queued += 1;
      continue;
    }
    // Q2: a per-dependent read failure must not abort the event (the
    // handler's contract: per-dependent failures are queued for the
    // sweep). Queue this dependent with the existing marker convention,
    // count the attempt against the cap, and continue so later
    // dependents are still processed and state is still persisted.
    let dependent: Issue | null;
    try {
      dependent = await ctx.issues.get(summary.id, companyId);
    } catch (err) {
      const reasonForPending = buildParkedReason(root, parked.kind, trigger, atIso, event.eventId ?? null, summary.id, occurrenceId);
      state.pending.push({ rootId, transition, dependentId: summary.id, marker: reasonForPending.marker, attempts: 1, queuedAt: atIso, lastError: String(err) });
      queued += 1;
      attempted += 1;
      continue;
    }
    if (!dependent || isTerminal(dependent) || dependent.status !== "blocked") {
      skipped += 1;
      continue;
    }
    const reason = buildParkedReason(root, parked.kind, trigger, atIso, event.eventId ?? null, dependent.id, occurrenceId);
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

  await writeParkedStateConvergent(ctx, companyId, state, base);
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
  const base = cloneParkedState(state);
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
    // Q2: a read failure (root or dependent) retains the entry in
    // `remaining` instead of aborting the drain, so the queued wake
    // survives for the next tick and later entries are still processed.
    let root: Issue | null;
    try {
      root = await ctx.issues.get(entry.rootId, companyId);
    } catch {
      remaining.push(entry);
      continue;
    }
    const parked = root ? isParkedRoot(root) : null;
    if (!root || !parked) {
      dropped += 1;
      continue;
    }
    const baseTransition = `${root.status}:${parked.kind}`;
    if (entry.transition !== baseTransition && !entry.transition.startsWith(`${baseTransition}@`)) {
      dropped += 1;
      continue;
    }
    const window = state.windows[entry.rootId];
    if (window?.transition === entry.transition && window.woken[entry.dependentId] !== undefined) {
      dropped += 1;
      continue;
    }
    let dependent: Issue | null;
    try {
      dependent = await ctx.issues.get(entry.dependentId, companyId);
    } catch {
      remaining.push(entry);
      continue;
    }
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
    const occurrenceId = entry.transition.includes("@") ? entry.transition.slice(entry.transition.indexOf("@") + 1) : "legacy";
    const reason = buildParkedReason(root, parked.kind, trigger, atIso, null, dependent.id, occurrenceId);
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
      state.windows[entry.rootId] = { transition: entry.transition, occurrenceId, firstSeenAt: atIso, woken: { [entry.dependentId]: result.kind } };
    }
    drained += 1;
  }

  state.pending = remaining;
  await writeParkedStateConvergent(ctx, companyId, state, base);
  return { drained, dropped, remaining: remaining.length };
}
