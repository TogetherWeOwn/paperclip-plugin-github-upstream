import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { startWorkerRpcHost } from "@paperclipai/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import manifest, { AUDIT_JOB_KEY, ITEM_JOB_KEY, RELEASE_JOB_KEY, REVIEW_GUARD_JOB_KEY } from "./manifest.js";

const COMPANY = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "bbbbbbbb-0000-4000-8000-000000000001";
const TOKEN = "synthetic-token";
const SCHEDULED_AT = "2026-11-11T01:30:09Z";

// Minimal config: PAT mode (tokenSecretRef) so scans resolve a token and run;
// followThroughTrackerIssueId empty so item/audit early-return skipped-no-tracker
// after auth; releaseRepos unset so resolveConfig falls back to the defaults.
const pluginConfig: Record<string, unknown> = {
  tokenSecretRef: { type: "secret_ref", secretId: "00000000-0000-4000-8000-000000000099" },
};

type HostCall = { method: string; params: Record<string, unknown> };

/**
 * Real installed worker RPC + plugin definition; synthetic host wire replies.
 * The synthetic host mirrors the production governed-access gate that caused
 * TWO-5876 (v0.1.0 at 14134233: every scheduled tick failed with
 * "companies.list … unknown invocation scope"):
 *
 * - `config.get` without an explicit companyId is refused, exactly as the
 *   production host's resolveRequiredCompanyId refuses a company-less read
 *   during scheduled (proactive, no invocation company scope) jobs.
 * - `companies.list` is refused with the production invocation-scope error
 *   on every call: any regression back to listing companies from a scheduled
 *   job fails loudly instead of silently passing.
 *
 * No SDK mock, no host/core, and no network are involved. Scheduled jobs
 * (`runJob`) carry only {jobKey, runId, trigger, scheduledAt} — no company
 * scope — exactly as the production host delivers them.
 */
async function upstreamHost() {
  // One worker per plugin: reset the module so each test gets a fresh worker
  // with no captured company carried over from the last test.
  vi.resetModules();
  const { default: plugin } = await import("./plugin.js");
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines = createInterface({ input: stdout });
  const calls: HostCall[] = [];
  const state = new Map<string, unknown>();
  const keyOf = (p: Record<string, unknown>) => `${p.scopeKind}:${p.scopeId}:${p.namespace}:${p.stateKey}`;
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const reply = (id: string | number, result: unknown) =>
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  const replyError = (id: string | number, message: string) =>
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message } })}\n`);

  lines.on("line", (line) => {
    const message = JSON.parse(line) as {
      id?: string | number; method?: string; params?: Record<string, unknown>;
      result?: unknown; error?: { message?: string };
    };
    if (message.id !== undefined && message.method === undefined) {
      const waiter = pending.get(String(message.id));
      if (waiter) {
        pending.delete(String(message.id));
        if (message.error) waiter.reject(new Error(message.error.message ?? "host request failed"));
        else waiter.resolve(message.result ?? null);
      }
      return;
    }
    // Notifications (e.g. `log`) carry no id and need no reply.
    if (message.method === undefined || message.id === undefined) return;
    const { method, params, id } = message as { method: string; params: Record<string, unknown>; id: string | number };
    calls.push({ method, params });
    queueMicrotask(() => {
      try {
        switch (method) {
          case "config.get":
            // Mirror the production gate: proactive job invocations carry no
            // company scope, so a company-less read is refused here.
            if (!params.companyId) replyError(id, "company context is required");
            else reply(id, pluginConfig);
            return;
          case "companies.list":
            // The TWO-5876 production failure, verbatim in shape: scheduled
            // jobs reference a missing/expired/unknown invocation scope.
            replyError(id, 'Plugin "synthetic" is not allowed to perform "companies.list": the worker referenced a missing, expired, or unknown invocation scope');
            return;
          case "state.get":
            reply(id, state.get(keyOf(params)) ?? null);
            return;
          case "state.set":
            state.set(keyOf(params), params.value);
            reply(id, null);
            return;
          case "secrets.resolve":
            reply(id, TOKEN);
            return;
          case "http.fetch":
            reply(id, { status: 404, headers: {}, body: "not found" });
            return;
          case "events.subscribe":
            reply(id, null);
            return;
          case "issues.list":
            reply(id, []);
            return;
          default:
            replyError(id, `synthetic host fixture refused ${method}`);
        }
      } catch {
        replyError(id, "synthetic host fixture refused request");
      }
    });
  });
  const host = startWorkerRpcHost({ plugin, stdin, stdout, rpcTimeoutMs: 10_000 });
  const stop = () => { host.stop(); lines.close(); stdin.destroy(); stdout.destroy(); };
  const send = (id: string, method: string, params: Record<string, unknown>) =>
    new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const runsFor = (companyId: string): unknown[] => {
    const value = state.get(`company:${companyId}:undefined:runs`);
    return Array.isArray(value) ? value : [];
  };
  return { send, stop, calls, runsFor };
}

const initializeParams = {
  manifest,
  config: {},
  apiVersion: 1,
  instanceInfo: { instanceId: "11111111-1111-4111-8111-111111111111", hostVersion: "0.0.0-fixture" },
};
const jobParams = (jobKey: string) => ({
  job: { jobKey, runId: "dddddddd-0000-4000-8000-000000000001", trigger: "schedule", scheduledAt: SCHEDULED_AT },
});

describe("scheduled jobs over the real SDK/host contract (TWO-5876)", () => {
  for (const jobKey of [RELEASE_JOB_KEY, ITEM_JOB_KEY, AUDIT_JOB_KEY, REVIEW_GUARD_JOB_KEY]) {
    it(`${jobKey} reads config only for the delivered company and never lists companies`, async () => {
      const h = await upstreamHost();
      try {
        await h.send("initialize", "initialize", initializeParams);
        // The host replays stored company config here, before any job runs.
        await h.send("config", "configChanged", { config: pluginConfig, companyId: COMPANY });
        await h.send("job", "runJob", jobParams(jobKey));

        const configReads = h.calls.filter((c) => c.method === "config.get");
        expect(configReads.length).toBeGreaterThan(0);
        expect(configReads.every((c) => c.params.companyId === COMPANY)).toBe(true);
        expect(h.calls.some((c) => c.method === "companies.list")).toBe(false);
      } finally { h.stop(); }
    });
  }

  it("release/item/audit scans record run stats for the delivered company", async () => {
    for (const [jobKey, job] of [[RELEASE_JOB_KEY, "release-scan"], [ITEM_JOB_KEY, "item-scan"], [AUDIT_JOB_KEY, "audit-scan"]] as const) {
      const h = await upstreamHost();
      try {
        await h.send("initialize", "initialize", initializeParams);
        await h.send("config", "configChanged", { config: pluginConfig, companyId: COMPANY });
        await h.send("job", "runJob", jobParams(jobKey));

        const runs = h.runsFor(COMPANY);
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({ job });
      } finally { h.stop(); }
    }
  });

  it("every scheduled job fails closed with zero reads and zero writes when no config was delivered", async () => {
    for (const jobKey of [RELEASE_JOB_KEY, ITEM_JOB_KEY, AUDIT_JOB_KEY, REVIEW_GUARD_JOB_KEY]) {
      const h = await upstreamHost();
      try {
        await h.send("initialize", "initialize", initializeParams);
        await h.send("job", "runJob", jobParams(jobKey));

        expect(h.calls.some((c) => c.method === "config.get")).toBe(false);
        expect(h.calls.some((c) => c.method === "companies.list")).toBe(false);
        expect(h.runsFor(COMPANY)).toHaveLength(0);
      } finally { h.stop(); }
    }
  });

  it("an unscoped config delivery captures nothing: jobs perform zero reads", async () => {
    const h = await upstreamHost();
    try {
      await h.send("initialize", "initialize", initializeParams);
      await h.send("config", "configChanged", { config: pluginConfig, companyId: null });
      await h.send("job", "runJob", jobParams(RELEASE_JOB_KEY));

      expect(h.calls.some((c) => c.method === "config.get")).toBe(false);
      expect(h.runsFor(COMPANY)).toHaveLength(0);
    } finally { h.stop(); }
  });

  it("a second company's delivery widens the scan to both companies, still never company-less", async () => {
    // multiCompanyConfig: the plugin genuinely scans every delivered company,
    // keyed by companyId at each read (unlike the single-company custody fix).
    const h = await upstreamHost();
    try {
      await h.send("initialize", "initialize", initializeParams);
      await h.send("config-a", "configChanged", { config: pluginConfig, companyId: COMPANY });
      await h.send("config-b", "configChanged", { config: pluginConfig, companyId: OTHER });
      await h.send("job", "runJob", jobParams(ITEM_JOB_KEY));

      const configReads = h.calls.filter((c) => c.method === "config.get");
      expect(new Set(configReads.map((c) => c.params.companyId))).toEqual(new Set([COMPANY, OTHER]));
      expect(h.calls.some((c) => c.method === "companies.list")).toBe(false);
      expect(h.runsFor(COMPANY)).toHaveLength(1);
      expect(h.runsFor(OTHER)).toHaveLength(1);
    } finally { h.stop(); }
  });
});
