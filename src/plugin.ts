import { definePlugin } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { resolveConfig } from "./config.js";
import { runAuditScan } from "./audit.js";
import { runItemScan, type ItemMap } from "./items.js";
import { AUDIT_JOB_KEY, ITEM_JOB_KEY, RELEASE_JOB_KEY, REVIEW_GUARD_JOB_KEY } from "./manifest.js";
import { runReleaseScan } from "./releases.js";
import { handleReviewEvent, runReviewGuardSweep } from "./review-guard.js";
import { recordRunStats, stateKey, type RunStats } from "./state.js";
import { EMPTY_SUMMARY, SUMMARY_DATA_KEY, summarizeItems } from "./summary.js";

/**
 * Companies whose plugin config the host has delivered to this worker.
 *
 * Scheduled jobs run with no invocation company scope, so the company-less
 * reads the old scheduled path made (`ctx.companies.list()` then
 * `ctx.config.get(company.id)` per listed company) die against the host
 * gate: `companies.list` fails with "unknown invocation scope" (TWO-5876,
 * v0.1.0 at 14134233 — every scheduled tick failed from the first install
 * minute, while 8280061 succeeded). The host replays stored company config
 * through `configChanged` (including at worker startup, before scheduled
 * jobs register); `onConfigChanged` captures the delivered company there
 * and the scheduled path reads config explicitly with it — the TWO-5786
 * custody fix pattern. Nothing here is derived from config contents: the
 * delivered scope (`context.companyId`) is the authority, so a delivery
 * cannot retarget the scan to a company the host did not name.
 */
const deliveredCompanyIds = new Set<string>();

/** Companies captured from host `configChanged` deliveries, in delivery order. */
export const capturedCompanyIds = (): string[] => [...deliveredCompanyIds];

const plugin = definePlugin({
  // One worker serves every company's scans, keyed by companyId at each
  // read, so it must opt in to multi-company config delivery (the SDK
  // single-tenant guard otherwise rejects a second company's config).
  multiCompanyConfig: true,
  async onConfigChanged(_newConfig, context) {
    const companyId = typeof context?.companyId === "string" ? context.companyId : "";
    // Unscoped deliveries name no company: they neither retarget nor clear
    // the capture (same rule as the TWO-5786 custody capture).
    if (!companyId) return;
    deliveredCompanyIds.add(companyId);
  },
  async setup(ctx: PluginContext) {
    ctx.jobs.register(RELEASE_JOB_KEY, async () => {
      await scanAll(ctx, "release");
    });
    ctx.jobs.register(ITEM_JOB_KEY, async () => {
      await scanAll(ctx, "items");
    });
    ctx.jobs.register(AUDIT_JOB_KEY, async () => {
      await scanAll(ctx, "audit");
    });
    // Review-guard (TWO-5794): the events path stamps new code cards
    // without a live reviewer stage immediately; the sweep is the backstop.
    ctx.jobs.register(REVIEW_GUARD_JOB_KEY, async () => {
      await sweepReviewGuard(ctx);
    });
    ctx.events.on("issue.created", async (event) => {
      await handleReviewEvent(ctx, event);
    });
    ctx.events.on("issue.updated", async (event) => {
      await handleReviewEvent(ctx, event);
    });
    ctx.data.register(SUMMARY_DATA_KEY, async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : "";
      if (!companyId) return { ...EMPTY_SUMMARY };
      const stored = (await ctx.state.get(stateKey(companyId, "items")) as ItemMap | null) ?? {};
      return summarizeItems(stored);
    });
  },
});

async function scanAll(ctx: PluginContext, job: "release" | "items" | "audit"): Promise<void> {
  // Fail closed without a delivered company: never fall back to a
  // company-less `companies.list()` / `config.get()` the host gate rejects
  // during scheduled jobs (TWO-5876).
  if (deliveredCompanyIds.size === 0) {
    ctx.logger.info("github-upstream scan skipped: no company config delivered", { job });
    return;
  }
  for (const companyId of capturedCompanyIds()) {
    try {
      const raw = await ctx.config.get(companyId);
      // Fail closed: a company with no explicit config row gets nothing —
      // neither the default repos nor the default agent assignees.
      if (!raw || Object.keys(raw).length === 0) {
        ctx.logger.info("github-upstream scan skipped: no plugin config for company", { companyId, job });
        continue;
      }
      const config = resolveConfig(raw);
      const fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => ctx.http.fetch(url, init);
      const stats: RunStats = job === "release"
        ? (await runReleaseScan(ctx, companyId, config, { fetchImpl })).stats
        : job === "audit"
          ? (await runAuditScan(ctx, companyId, config, { fetchImpl })).stats
          : (await runItemScan(ctx, companyId, config, { fetchImpl })).stats;
      await recordRunStats(ctx, companyId, stats);
      ctx.logger.info("github-upstream scan finished", {
        companyId,
        job: stats.job,
        ok200: stats.ok200,
        notModified304: stats.notModified304,
        errors: stats.errors,
        wakes: stats.wakes,
        creates: stats.creates,
        capped: stats.capped,
        dryRun: config.dryRun,
      });
    } catch (err) {
      ctx.logger.error("github-upstream scan failed", { companyId, job, error: String(err) });
    }
  }
}

async function sweepReviewGuard(ctx: PluginContext): Promise<void> {
  // No plugin-state RunStats for the sweep: it is not a GitHub sync, and its
  // cost model (a list page + at most a few writes) does not fit the
  // GitHub-run counters. The `review-guard.applied` state record and the
  // per-sweep log line are the audit trail.
  if (deliveredCompanyIds.size === 0) {
    ctx.logger.info("review-guard sweep skipped: no company config delivered");
    return;
  }
  for (const companyId of capturedCompanyIds()) {
    try {
      const raw = await ctx.config.get(companyId);
      // Fail closed, same as the scans: no config row, no writes.
      if (!raw || Object.keys(raw).length === 0) {
        ctx.logger.info("review-guard sweep skipped: no plugin config for company", { companyId });
        continue;
      }
      await runReviewGuardSweep(ctx, companyId, resolveConfig(raw));
    } catch (err) {
      ctx.logger.error("review-guard sweep failed", { companyId, error: String(err) });
    }
  }
}

export default plugin;
