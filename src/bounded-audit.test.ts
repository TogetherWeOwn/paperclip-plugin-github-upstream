import type { PluginContext } from "@paperclipai/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let runBoundedAudit: typeof import("./bounded-audit.js").runBoundedAudit;

beforeEach(async () => {
  vi.resetModules();
  ({ runBoundedAudit } = await import("./bounded-audit.js"));
});

const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;

async function withDeadline(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = realSetTimeout(() => reject(new Error("audit cleanup timed out")), 1000);
      }),
    ]);
  } finally {
    if (timer !== undefined) realClearTimeout(timer);
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function context() {
  const error = vi.fn();
  return { ctx: { logger: { error } } as unknown as PluginContext, error };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("bounded audit", () => {
  it("clears the timeout when work completes", async () => {
    vi.useFakeTimers();
    const { ctx, error } = context();
    let signal: AbortSignal | undefined;
    await runBoundedAudit(ctx, "company", "issue", async (received) => { signal = received; });
    await vi.advanceTimersByTimeAsync(250);
    expect(signal?.aborted).toBe(false);
    expect(error).not.toHaveBeenCalled();
  });

  it("logs a rejected operation without propagating it", async () => {
    const { ctx, error } = context();
    await runBoundedAudit(ctx, "company", "issue", async () => { throw new Error("failure"); }, "QA", "change");
    expect(error).toHaveBeenCalledWith("review-guard audit failed", {
      companyId: "company", issueId: "issue", role: "QA", changeKey: "change",
    });
  });

  it("logs a late rejection after the caller times out", async () => {
    vi.useFakeTimers();
    const { ctx, error } = context();
    const held = deferred();
    const finished = deferred();
    const failureLogged = deferred();
    error.mockImplementation((message: string) => {
      if (message === "review-guard audit failed") failureLogged.resolve();
    });
    const call = runBoundedAudit(ctx, "company", "issue", async () => {
      try {
        await held.promise;
        throw new Error("late failure");
      } finally {
        finished.resolve();
      }
    }, "Security", "change");
    void call.catch(() => {});
    try {
      await vi.advanceTimersByTimeAsync(250);
      await call;
      expect(error).toHaveBeenCalledWith("review-guard audit abandoned: timed out", {
        companyId: "company", issueId: "issue", role: "Security", changeKey: "change",
      });
      expect(error).not.toHaveBeenCalledWith("review-guard audit failed", expect.anything());
    } finally {
      held.resolve();
      await withDeadline(Promise.all([finished.promise, failureLogged.promise, call]));
    }
    expect(error).toHaveBeenCalledWith("review-guard audit failed", {
      companyId: "company", issueId: "issue", role: "Security", changeKey: "change",
    });
  });

  it("retains timed-out slots until work settles and then admits work again", async () => {
    vi.useFakeTimers();
    const { ctx, error } = context();
    const held = deferred();
    const started = vi.fn();
    const signals: AbortSignal[] = [];
    const finished: Promise<void>[] = [];
    const probeHeld = deferred();
    const probes: Promise<void>[] = [];
    let stopProbing = false;
    let probing: Promise<void> = Promise.resolve();
    const calls = Array.from({ length: 8 }, () => runBoundedAudit(ctx, "company", "issue", async (signal) => {
      const completion = deferred();
      finished.push(completion.promise);
      try {
        started();
        signals.push(signal);
        await held.promise;
      } finally {
        completion.resolve();
      }
    }));
    try {
      await vi.advanceTimersByTimeAsync(250);
      await Promise.all(calls);
      expect(started).toHaveBeenCalledTimes(8);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(error.mock.calls.filter(([message]) => message === "review-guard audit abandoned: timed out")).toHaveLength(8);
      const refused = vi.fn(async () => {});
      await runBoundedAudit(ctx, "company", "other", refused, "Security", "key");
      expect(refused).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith("review-guard audit-admission-saturated", {
        companyId: "company", issueId: "other", role: "Security", changeKey: "key",
      });
      held.resolve();
      // Hold each admitted probe, so eight starts prove all eight original slots were released.
      probing = (async () => {
        while (probes.length < 8 && !stopProbing) {
          const entered = deferred();
          const probe = runBoundedAudit(ctx, "company", "probe", async () => {
            entered.resolve();
            await probeHeld.promise;
          });
          void probe.catch(() => {});
          const admitted = await Promise.race([
            entered.promise.then(() => true),
            probe.then(() => false),
          ]);
          if (admitted) probes.push(probe);
          else await new Promise<void>((resolve) => realSetTimeout(resolve, 1));
        }
      })();
      await withDeadline(probing);
      expect(probes).toHaveLength(8);
    } finally {
      stopProbing = true;
      held.resolve();
      probeHeld.resolve();
      await withDeadline(probing);
      await withDeadline(Promise.all([...calls, ...finished, ...probes]));
    }
  });
});
