import type { PluginContext } from "@paperclipai/plugin-sdk";

const AUDIT_TIMEOUT_MS = 250;
const MAX_IN_FLIGHT_AUDITS = 8;
let inFlightAudits = 0;

/** A timeout stops waiting, not the host RPC. Keep its slot until it settles. */
export async function runBoundedAudit(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  work: (signal: AbortSignal) => Promise<void>,
  role?: string,
  changeKey?: string,
): Promise<void> {
  if (inFlightAudits >= MAX_IN_FLIGHT_AUDITS) {
    ctx.logger.error("review-guard audit-admission-saturated", { companyId, issueId, role, changeKey });
    return;
  }
  inFlightAudits += 1;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = Promise.resolve()
    .then(() => work(controller.signal))
    .catch(() => {
      ctx.logger.error("review-guard audit failed", { companyId, issueId, role, changeKey });
    })
    .finally(() => {
      inFlightAudits -= 1;
    });
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      ctx.logger.error("review-guard audit abandoned: timed out", { companyId, issueId, role, changeKey });
      resolve();
    }, AUDIT_TIMEOUT_MS);
  });
  await Promise.race([operation, timeout]);
  if (timer !== undefined) clearTimeout(timer);
}
