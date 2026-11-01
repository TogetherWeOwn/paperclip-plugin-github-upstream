import { IssuesList, MetricCard, useHostContext, usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { IssuesListFilters, PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import { ORIGIN_KIND_PREFIX } from "../manifest.js";
import { EMPTY_SUMMARY, SUMMARY_DATA_KEY, type UpstreamSummary } from "../summary.js";

/**
 * Native issue-list filter for the GitHub tab. The plugin writes
 * `originKind: "plugin:togetherweown.github-upstream:release|item"` on every
 * card it owns, so one prefix covers release-intake and follow-through cards.
 * Native filter, search, sort and saved views come from the host for free.
 */
export const GITHUB_TAB_FILTERS: IssuesListFilters = {
  originKindPrefix: ORIGIN_KIND_PREFIX,
};

/** Persisted view key for the tab's saved views (filters, search, sort). */
export const GITHUB_TAB_VIEW_STATE_KEY = "github-upstream";

export interface GitHubUpstreamViewProps {
  companyId: string | null;
  summary: UpstreamSummary;
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
}

/** Pure view: MetricCard row over the host's native IssuesList. No bridge calls. */
export function GitHubUpstreamView({ companyId, summary, loading, error, onRetry }: GitHubUpstreamViewProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: 16 }}>
      <div
        style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}
        aria-busy={loading}
      >
        <MetricCard label="Open PRs" value={summary.openPRs} />
        <MetricCard label="Red CI" value={summary.redCI} />
        <MetricCard label="Awaiting maintainer" value={summary.awaitingMaintainer} />
        <MetricCard label="Awaiting us" value={summary.awaitingUs} />
      </div>
      {error ? (
        <div role="alert">
          Could not load upstream counts: {error}{" "}
          {onRetry ? <button type="button" onClick={onRetry}>Retry</button> : null}
        </div>
      ) : null}
      <IssuesList
        companyId={companyId}
        filters={GITHUB_TAB_FILTERS}
        viewStateKey={GITHUB_TAB_VIEW_STATE_KEY}
      />
      {loading ? <div>Loading upstream counts…</div> : null}
    </div>
  );
}

/** Host-mounted page component. Reads context and worker data, then renders the pure view. */
export function GitHubUpstreamPage({ context }: PluginPageProps) {
  const host = useHostContext();
  const companyId = context.companyId ?? host.companyId ?? null;
  const { data, loading, error, refresh } = usePluginData<UpstreamSummary>(
    SUMMARY_DATA_KEY,
    companyId ? { companyId } : {},
  );
  return (
    <GitHubUpstreamView
      companyId={companyId}
      summary={data ?? EMPTY_SUMMARY}
      loading={loading}
      error={error?.message ?? null}
      onRetry={() => void refresh()}
    />
  );
}
