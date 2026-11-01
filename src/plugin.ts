import { definePlugin } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { resolveConfig } from "./config.js";
import { runAuditScan } from "./audit.js";
import { runItemScan, type ItemMap } from "./items.js";
import { AUDIT_JOB_KEY, ITEM_JOB_KEY, RELEASE_JOB_KEY } from "./manifest.js";
import { runReleaseScan } from "./releases.js";
import { recordRunStats, stateKey, type RunStats } from "./state.js";
import { EMPTY_SUMMARY, SUMMARY_DATA_KEY, summarizeItems } from "./summary.js";

const plugin = definePlugin({
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
    ctx.data.register(SUMMARY_DATA_KEY, async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : "";
      if (!companyId) return { ...EMPTY_SUMMARY };
      const stored = (await ctx.state.get(stateKey(companyId, "items")) as ItemMap | null) ?? {};
      return summarizeItems(stored);
    });
  },
});

async function scanAll(ctx: PluginContext, job: "release" | "items" | "audit"): Promise<void> {
  const companies = await ctx.companies.list();
  for (const company of companies) {
    try {
      const raw = await ctx.config.get(company.id);
      // Fail closed: a company with no explicit config row gets nothing —
      // neither the default repos nor the default agent assignees.
      if (!raw || Object.keys(raw).length === 0) {
        ctx.logger.info("github-upstream scan skipped: no plugin config for company", { companyId: company.id, job });
        continue;
      }
      const config = resolveConfig(raw);
      const fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => ctx.http.fetch(url, init);
      const stats: RunStats = job === "release"
        ? (await runReleaseScan(ctx, company.id, config, { fetchImpl })).stats
        : job === "audit"
          ? (await runAuditScan(ctx, company.id, config, { fetchImpl })).stats
          : (await runItemScan(ctx, company.id, config, { fetchImpl })).stats;
      await recordRunStats(ctx, company.id, stats);
      ctx.logger.info("github-upstream scan finished", {
        companyId: company.id,
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
      ctx.logger.error("github-upstream scan failed", { companyId: company.id, job, error: String(err) });
    }
  }
}

export default plugin;
