import { definePlugin } from "@paperclipai/plugin-sdk";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { resolveConfig } from "./config.js";
import { runItemScan, type ItemMap } from "./items.js";
import { ITEM_JOB_KEY, RELEASE_JOB_KEY } from "./manifest.js";
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
    ctx.data.register(SUMMARY_DATA_KEY, async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : "";
      if (!companyId) return { ...EMPTY_SUMMARY };
      const stored = (await ctx.state.get(stateKey(companyId, "items")) as ItemMap | null) ?? {};
      return summarizeItems(stored);
    });
  },
});

async function scanAll(ctx: PluginContext, job: "release" | "items"): Promise<void> {
  const companies = await ctx.companies.list();
  for (const company of companies) {
    try {
      const config = resolveConfig(await ctx.config.get(company.id));
      const fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => ctx.http.fetch(url, init);
      const stats: RunStats = job === "release"
        ? (await runReleaseScan(ctx, company.id, config, { fetchImpl })).stats
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
        dryRun: config.dryRun,
      });
    } catch (err) {
      ctx.logger.error("github-upstream scan failed", { companyId: company.id, job, error: String(err) });
    }
  }
}

export default plugin;
