import { readFileSync, writeFileSync } from "node:fs";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { resolveConfig, type UpstreamConfig } from "./config.js";
import { runItemScan, type ItemOutcome } from "./items.js";
import { runReleaseScan, type ReleaseOutcome } from "./releases.js";
import type { RunStats } from "./state.js";

export interface DryRunCard {
  id: string;
  identifier?: string | null;
  parentId?: string | null;
  originKind?: string | null;
  originId?: string | null;
  labels?: Array<{ name: string }>;
  labelIds?: string[];
  description?: string | null;
  workProducts?: Array<{ url: string | null }>;
  assigneeAgentId?: string | null;
  status?: string;
}

export interface DryRunOptions {
  companyId: string;
  token: string;
  config: Record<string, unknown>;
  /** Cards treated as the follow-through tracker subtree children. */
  cards: DryRunCard[];
  /** Tracker issue id; defaults to the most common parentId among cards. */
  trackerId?: string;
  /** Path to the JSON file persisting ETags between runs. */
  statePath: string;
}

export interface DryRunResult {
  config: UpstreamConfig;
  releaseOutcomes: ReleaseOutcome[];
  itemOutcomes: ItemOutcome[];
  stats: RunStats[];
  /** Every write the run wanted to make but did not. */
  intended: string[];
}

/**
 * Run both jobs end to end against the real GitHub API with a file-backed
 * state store and a stub Paperclip client. Nothing is created, woken or
 * updated: config.dryRun is forced on, and the stub throws if a write slips
 * through. Run twice with the same --state file: the second run should be
 * nearly all 304s and no intended writes.
 */
export async function runDryRun(options: DryRunOptions): Promise<DryRunResult> {
  const trackerId = options.trackerId ?? inferTrackerId(options.cards);
  // Fail-closed scans require an explicit secret_ref binding; the dry-run CLI
  // always carries an explicit token, so bind it. The stub resolve() below
  // returns that token for any ref.
  const config = resolveConfig({
    ...options.config,
    dryRun: true,
    followThroughTrackerIssueId: trackerId,
    tokenSecretRef: options.config.tokenSecretRef ?? { type: "secret_ref", secretId: "dry-run" },
  });
  const intended: string[] = [];

  let state: Record<string, unknown> = {};
  try {
    state = JSON.parse(readFileSync(options.statePath, "utf8")) as Record<string, unknown>;
  } catch {
    state = {};
  }
  const saveState = () => writeFileSync(options.statePath, `${JSON.stringify(state, null, 2)}\n`);
  const scopeKey = (input: { stateKey: string }) => `company:${options.companyId}:${input.stateKey}`;

  const children = options.cards.filter((c) => (c.parentId ?? null) === trackerId);
  const ctx = {
    companies: {
      list: async () => [{ id: options.companyId }],
      get: async (id: string) => (id === options.companyId ? { id } : null),
    },
    config: {
      get: async () => ({ ...options.config, dryRun: true, followThroughTrackerIssueId: trackerId }),
    },
    secrets: {
      resolve: async () => options.token,
    },
    state: {
      get: async (input: { stateKey: string }) => (scopeKey(input) in state ? state[scopeKey(input)] : null),
      set: async (input: { stateKey: string }, value: unknown) => {
        state[scopeKey(input)] = value;
        saveState();
      },
      delete: async (input: { stateKey: string }) => {
        delete state[scopeKey(input)];
        saveState();
      },
    },
    issues: {
      list: async (input: { originKind?: string; originId?: string }) =>
        children.filter(
          (c) => (input.originKind === undefined || c.originKind === input.originKind) && (input.originId === undefined || c.originId === input.originId),
        ),
      getSubtree: async (issueId: string) => {
        if (issueId !== trackerId) throw new Error(`dry-run: unknown tracker ${issueId}`);
        return { rootIssueId: trackerId, companyId: options.companyId, issueIds: children.map((c) => c.id), issues: children };
      },
      create: async (input: Record<string, unknown>) => {
        intended.push(`create ${String(input.originKind ?? "")} ${String(input.originId ?? input.title ?? "")}`);
        throw new Error("dry-run: issues.create must not be called");
      },
      update: async () => {
        intended.push("update <card>");
        throw new Error("dry-run: issues.update must not be called");
      },
      requestWakeup: async () => {
        intended.push("wakeup <card>");
        throw new Error("dry-run: issues.requestWakeup must not be called");
      },
    },
    logger: {
      info: (message: string, meta?: Record<string, unknown>) => console.error(`[info] ${message} ${meta ? JSON.stringify(meta) : ""}`),
      warn: (message: string, meta?: Record<string, unknown>) => console.error(`[warn] ${message} ${meta ? JSON.stringify(meta) : ""}`),
      error: (message: string, meta?: Record<string, unknown>) => console.error(`[error] ${message} ${meta ? JSON.stringify(meta) : ""}`),
      debug: () => undefined,
    },
  } as unknown as PluginContext;

  const fetchImpl = (url: string, init?: RequestInit) => fetch(url, init);
  const release = await runReleaseScan(ctx, options.companyId, config, { fetchImpl });
  const items = await runItemScan(ctx, options.companyId, config, { fetchImpl });
  return { config, releaseOutcomes: release.outcomes, itemOutcomes: items.outcomes, stats: [release.stats, items.stats], intended };
}

function inferTrackerId(cards: DryRunCard[]): string {
  const counts = new Map<string, number>();
  for (const card of cards) {
    if (card.parentId) counts.set(card.parentId, (counts.get(card.parentId) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [id, count] of counts) {
    if (count > bestCount) {
      best = id;
      bestCount = count;
    }
  }
  return best;
}
