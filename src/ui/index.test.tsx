import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import type { IssuesListProps, MetricCardProps } from "@paperclipai/plugin-sdk/ui";
import { EMPTY_SUMMARY } from "../summary.js";
import { GITHUB_TAB_FILTERS, GITHUB_TAB_VIEW_STATE_KEY, GitHubUpstreamView } from "./index.js";

const seenLists: IssuesListProps[] = [];

function installBridge(): void {
  const MetricCardStub = (props: MetricCardProps) =>
    createElement("div", { "data-metric-card": props.label }, `${props.label}: ${props.value}`);
  const IssuesListStub = (props: IssuesListProps) => {
    seenLists.push(props);
    return createElement("div", { "data-issues-list": "true" });
  };
  (globalThis as Record<string, unknown>).__paperclipPluginBridge__ = {
    sdkUi: { MetricCard: MetricCardStub, IssuesList: IssuesListStub },
  };
}

describe("GitHubUpstreamView", () => {
  beforeEach(() => {
    seenLists.length = 0;
    installBridge();
  });

  it("renders the metric row with the summary counts", () => {
    const html = renderToStaticMarkup(
      <GitHubUpstreamView
        companyId="c-1"
        summary={{ ...EMPTY_SUMMARY, openPRs: 3, redCI: 1, awaitingMaintainer: 2, awaitingUs: 1, openItems: 5, trackedItems: 6 }}
        loading={false}
        error={null}
      />,
    );
    expect(html).toContain("Open PRs: 3");
    expect(html).toContain("Red CI: 1");
    expect(html).toContain("Awaiting maintainer: 2");
    expect(html).toContain("Awaiting us: 1");
  });

  it("scopes the native list by origin-kind prefix with a stable view key", () => {
    renderToStaticMarkup(
      <GitHubUpstreamView companyId="c-1" summary={EMPTY_SUMMARY} loading={false} error={null} />,
    );
    expect(seenLists).toHaveLength(1);
    expect(seenLists[0].companyId).toBe("c-1");
    expect(seenLists[0].filters).toEqual(GITHUB_TAB_FILTERS);
    expect(seenLists[0].filters?.originKindPrefix).toBe("plugin:togetherweown.github-upstream:");
    expect(seenLists[0].viewStateKey).toBe(GITHUB_TAB_VIEW_STATE_KEY);
  });

  it("shows loading and error states without losing the list", () => {
    const loading = renderToStaticMarkup(
      <GitHubUpstreamView companyId="c-1" summary={EMPTY_SUMMARY} loading error={null} />,
    );
    expect(loading).toContain("Loading upstream counts");

    const failed = renderToStaticMarkup(
      <GitHubUpstreamView companyId="c-1" summary={EMPTY_SUMMARY} loading={false} error="boom" onRetry={() => {}} />,
    );
    expect(failed).toContain("Could not load upstream counts: boom");
    expect(failed).toContain("Retry");
    // The native list still mounts so the tab stays usable on summary failure.
    expect(seenLists).toHaveLength(2);
  });
});
