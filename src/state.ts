import type { PluginContext, ScopeKey } from "@paperclipai/plugin-sdk";

/** Per-run cost counters, so the operator can show the sync costs zero LLM and nearly zero rate limit. */
export interface RunStats {
  at: string;
  job: "release-scan" | "item-scan" | "audit-scan";
  ok200: number;
  notModified304: number;
  errors: number;
  wakes: number;
  creates: number;
}

export const MAX_RUN_HISTORY = 50;

export const stateKey = (companyId: string, key: string): ScopeKey => ({
  scopeKind: "company",
  scopeId: companyId,
  stateKey: key,
});

interface BackoffRecord {
  backoffUntil: string | null;
}

export async function isBackedOff(ctx: PluginContext, companyId: string, nowMs: number): Promise<boolean> {
  const raw = (await ctx.state.get(stateKey(companyId, "rate-limit")) as BackoffRecord | null) ?? null;
  if (!raw?.backoffUntil) return false;
  return Date.parse(raw.backoffUntil) > nowMs;
}

export async function setBackoff(ctx: PluginContext, companyId: string, untilMs: number): Promise<void> {
  await ctx.state.set(stateKey(companyId, "rate-limit"), {
    backoffUntil: new Date(untilMs).toISOString(),
  } satisfies BackoffRecord);
}

export async function clearBackoff(ctx: PluginContext, companyId: string): Promise<void> {
  await ctx.state.set(stateKey(companyId, "rate-limit"), { backoffUntil: null } satisfies BackoffRecord);
}

/** Append one run's counters to the bounded history. */
export async function recordRunStats(ctx: PluginContext, companyId: string, stats: RunStats): Promise<RunStats[]> {
  const history = ((await ctx.state.get(stateKey(companyId, "runs"))) as RunStats[] | null) ?? [];
  const next = [...history, stats].slice(-MAX_RUN_HISTORY);
  await ctx.state.set(stateKey(companyId, "runs"), next);
  return next;
}
