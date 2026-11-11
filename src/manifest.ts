import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "togetherweown.github-upstream";
export const PLUGIN_VERSION = "0.1.0";
export const RELEASE_JOB_KEY = "release-scan";
export const ITEM_JOB_KEY = "item-scan";
export const AUDIT_JOB_KEY = "audit-scan";
export const REVIEW_GUARD_JOB_KEY = "review-guard-scan";
export const PARKED_JOB_KEY = "parked-propagation-scan";
export const DEFER_TOOL_NAME = "defer_blocked_card";

/** Origin kinds written by this plugin. The IssuesList page filters on the shared prefix. */
export const ORIGIN_KIND_PREFIX = "plugin:togetherweown.github-upstream:";
export const RELEASE_ORIGIN_KIND = `${ORIGIN_KIND_PREFIX}release`;
export const ITEM_ORIGIN_KIND = `${ORIGIN_KIND_PREFIX}item`;

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "GitHub Upstream",
  description:
    "Notices upstream GitHub changes deterministically, with zero LLM calls: ETag-conditional release polls create a release-intake card per new tag, and tracked issue/PR/discussion polls wake the owning card on real change. Also: review-guard stamps tier-appropriate review stages (QA always; Security for sensitive, including low/ordinary paths while content triggers cannot be ruled out) on code cards reaching in_review (TWO-5794, TWO-5879), and parked-blocker propagation wakes blocked dependents of a freshly parked root (TWO-5818).",
  author: "TogetherWeOwn",
  categories: ["automation"],
  capabilities: [
    "companies.read",
    "issues.read",
    "issue.subtree.read",
    "issues.create",
    "issues.update",
    "issue.comments.create",
    "issues.wakeup",
    "jobs.schedule",
    "http.outbound",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "events.subscribe",
    "agent.tools.register",
    "ui.page.register",
    "project.workspaces.read",
    "execution.workspaces.read",
    "issue.relations.read",
    "issue.comments.read",
    "agents.invoke",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "page",
        id: "github",
        displayName: "GitHub",
        exportName: "GitHubUpstreamPage",
        routePath: "github",
        order: 1,
      },
    ],
  },
  tools: [
    {
      name: DEFER_TOOL_NAME,
      displayName: "Defer blocked card",
      description:
        "Move one blocked Paperclip card to backlog under plugin authority (status-only blocked -> backlog), for an already-decided deferral the native resume guard blocks. Requires a done decision card naming the target. Refuses terminal cards and cards with a pending review stage. Idempotent.",
      parametersSchema: {
        type: "object",
        properties: {
          targetIssueId: {
            type: "string",
            description: "UUID of the blocked card to defer.",
          },
          decisionIssueId: {
            type: "string",
            description: "UUID of the done decision card that names the target card and records the defer decision.",
          },
          revisitTrigger: {
            type: "string",
            description: "Observable revisit event or UTC date that reopens this deferral.",
          },
        },
        required: ["targetIssueId", "decisionIssueId", "revisitTrigger"],
      },
    },
  ],
  jobs: [
    {
      jobKey: RELEASE_JOB_KEY,
      displayName: "Scan upstream releases",
      description:
        "GET /repos/{owner}/{repo}/releases/latest with If-None-Match for each configured release repo. A 304 means do nothing; a new tag after the install baseline creates exactly one release-intake card.",
      schedule: "*/10 * * * *",
    },
    {
      jobKey: ITEM_JOB_KEY,
      displayName: "Scan tracked upstream items",
      description:
        "ETag-conditional GETs for each tracked upstream issue/PR/discussion. On a real change (updated_at, comment/review count, check conclusion, head SHA, state/merged) the owning card is woken with a deterministic one-line reason. Our own comments and pushes sync labels/headers but never wake.",
      schedule: "*/15 * * * *",
    },
    {
      jobKey: REVIEW_GUARD_JOB_KEY,
      displayName: "Sweep in-review cards for a live reviewer stage",
      description:
        "Backstop for the review-guard event subscription: lists every `in_review` card and stamps tier-appropriate review stages (QA on every change; Security added for sensitive or unclassified changes; low/ordinary paths currently fail closed to sensitive because content triggers cannot be ruled out) plus an audit comment onto any code card (bound to a project workspace) that has none, upgrading QA-only cards when a newer head adds sensitive paths. Event subscriptions handle new cards immediately; the sweep catches missed events and pre-install cards.",
      schedule: "*/15 * * * *",
    },
    {
      jobKey: AUDIT_JOB_KEY,
      displayName: "Audit upstream posts for gate coverage",
      description:
        "Hourly deterministic audit: search for recent upstream issues, PRs, discussions, comments and reviews by our account, and flag any post with no approved gate card by labelling its follow-through card upstream:ungated and opening a card for the Chief of Staff.",
      schedule: "11 * * * *",
    },
    {
      jobKey: PARKED_JOB_KEY,
      displayName: "Drain parked-propagation queue",
      description:
        "Next-tick self-heal for parked-blocker propagation (TWO-5818): drains the pending wakes queued by the issue.updated subscription after fan-out overflow, re-validating that each root is still parked and each dependent non-terminal.",
      schedule: "*/15 * * * *",
    },
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      tokenSecretRef: {
        type: "object",
        properties: {
          type: { enum: ["secret_ref"] },
          secretId: { type: "string", minLength: 1 },
        },
        required: ["type", "secretId"],
        description:
          "Company secret binding for a read-only GitHub token (fine-grained PAT, public repos read-only). Must be the shared { type: 'secret_ref', secretId } object binding; anything else (including string refs) fails closed and the scan errors without scanning. Never a resolved value, only the ref object.",
      },
      appId: {
        type: "string",
        default: "",
        description:
          "GitHub App auth (preferred over tokenSecretRef): the numeric App ID, as a string. Set together with installationId and appPrivateKeySecretRef; exactly one auth mode must be set.",
      },
      installationId: {
        type: "string",
        default: "",
        description:
          "GitHub App auth: the numeric installation ID on the owner org, as a string. Digits only; anything else fails closed.",
      },
      appPrivateKeySecretRef: {
        type: "object",
        properties: {
          type: { enum: ["secret_ref"] },
          secretId: { type: "string", minLength: 1 },
        },
        required: ["type", "secretId"],
        description:
          "Company secret binding for the GitHub App's PEM private key. Must be the shared { type: 'secret_ref', secretId } object binding; resolved at call time only, never persisted or logged.",
      },
      releaseRepos: {
        type: "array",
        items: { type: "string" },
        default: ["router-for-me/CLIProxyAPI", "paperclipai/paperclip"],
        description: "Upstream repos whose latest release is tracked, as owner/repo.",
      },
      releaseIntakeAssigneeAgentId: {
        type: "string",
        default: "c4bd17fa-72df-43b4-83cd-df59ec7de5d0",
        description: "Agent assigned to release-intake cards (the Release Manager).",
      },
      releaseIntakeProjectId: {
        type: "string",
        default: "",
        description: "Project for release-intake cards (Factory Operations). Empty means no project.",
      },
      followThroughTrackerIssueId: {
        type: "string",
        default: "",
        description: "Tracker card whose subtree holds one follow-through card per upstream item. Empty disables item tracking.",
      },
      followThroughAssigneeAgentId: {
        type: "string",
        default: "7b8f576c-ebce-447f-a904-dda322df4220",
        description: "Default owner for newly created follow-through cards.",
      },
      ourHeadPrefixes: {
        type: "array",
        items: { type: "string" },
        default: ["TogetherWeOwn:"],
        description: "PR head labels that count as ours (forkOwner:branch prefix match).",
      },
      operatorLogin: {
        type: "string",
        default: "",
        description: "GitHub login of the operator; their authored issues/PRs count as ours.",
      },
      ourLogins: {
        type: "array",
        items: { type: "string" },
        default: [],
        description:
          "Extra GitHub logins that count as ours (e.g. the coming bot identity). Our own comments and pushes by these logins sync labels/headers but never wake the card.",
      },
      extraTrackedItems: {
        type: "array",
        items: {
          type: "object",
          properties: {
            owner: { type: "string" },
            repo: { type: "string" },
            kind: { type: "string", enum: ["issue", "pull", "discussion"] },
            number: { type: "number" },
          },
          required: ["owner", "repo", "kind", "number"],
        },
        default: [],
        description: "Upstream items to track in addition to the follow-through tracker subtree.",
      },
      discoveryQueries: {
        type: "array",
        items: { type: "string" },
        default: [],
        description:
          "GitHub issue-search query templates for discovering new ours items (run at most once per hour, within the 30/min search budget). Empty disables discovery; already-mapped items are always tracked.",
      },
      compareBases: {
        type: "object",
        additionalProperties: { type: "string" },
        default: {},
        description:
          "Per-repo compare base (tag or ref) for the release card, keyed by owner/repo. Used as the left side of the compare URL. A first-seen tag equal to the base is the install baseline: recorded, never carded.",
      },
      labelIdByName: {
        type: "object",
        additionalProperties: { type: "string" },
        default: {},
        description:
          "Paperclip label IDs keyed by label name. The plugin has no labels read API, so only names present here can be kept in sync (gh:repo/*, gh:type/*, gh:state/*, gh:ci/*).",
      },
      reviewGuardEnabled: {
        type: "boolean",
        default: false,
        description:
          "Review-guard (TWO-5794, TWO-5879): stamp tier-appropriate review stages onto code cards (bound to a project workspace) that reach in_review, or are created as code work, without a live reviewer stage. QA runs on every change; Security is added for sensitive or unclassified changes; low/ordinary paths currently fail closed to Sensitive because content triggers cannot be ruled out. A missing map, unreadable diff, or unmatched path also fails closed. A pending stage is upgraded when a newer head requires Security and never downgraded. Off by default.",
      },
      reviewGuardDryRun: {
        type: "boolean",
        default: false,
        description: "Review-guard dry-run: log intended review-policy stamps, upgrades and audit comments without making them.",
      },
      defaultReviewAgentIds: {
        type: "array",
        items: { type: "string" },
        default: [],
        description:
          "Review-guard: legacy reviewer chain (agent IDs, in stage order — e.g. Security then QA). Empty means the guard never writes that company's cards: it never invents a reviewer. When the tiered role lists below are unset, this chain is split by position (first ID Security, rest QA) so existing installs keep their Sensitive staffing.",
      },
      reviewAgentIdsByProjectId: {
        type: "object",
        additionalProperties: { type: "array", items: { type: "string" } },
        default: {},
        description:
          "Review-guard: per-project reviewer chain overrides, keyed by project ID. A project entry wins over defaultReviewAgentIds for that project's cards (split by position when tiered roles are unset).",
      },
      reviewQaAgentIds: {
        type: "array",
        items: { type: "string" },
        default: [],
        description:
          "Review-guard (TWO-5879): QA reviewer stage participants. QA runs on every tier. When set, wins over the legacy chain's positional split; when empty, that split applies.",
      },
      reviewQaAgentIdsByProjectId: {
        type: "object",
        additionalProperties: { type: "array", items: { type: "string" } },
        default: {},
        description:
          "Review-guard (TWO-5879): per-project QA reviewer overrides, keyed by project ID. A project entry wins over reviewQaAgentIds for that project's cards.",
      },
      reviewSecurityAgentIds: {
        type: "array",
        items: { type: "string" },
        default: [],
        description:
          "Review-guard (TWO-5879): Security reviewer stage participants, added for Sensitive/unknown tiers (Security then QA); low/ordinary paths currently fail closed to Sensitive because content triggers cannot be ruled out. When set, wins over the legacy chain's positional split; when empty, that split applies. With no usable Security reviewer a Sensitive card fails closed instead of downgrading to QA-only.",
      },
      reviewSecurityAgentIdsByProjectId: {
        type: "object",
        additionalProperties: { type: "array", items: { type: "string" } },
        default: {},
        description:
          "Review-guard (TWO-5879): per-project Security reviewer overrides, keyed by project ID. A project entry wins over reviewSecurityAgentIds for that project's cards.",
      },
      dryRun: {
        type: "boolean",
        default: false,
        description: "Log intended creates/wakes/updates without making them.",
      },
      auditLogins: {
        type: "array",
        items: { type: "string" },
        default: ["Rick7C2"],
        description:
          "GitHub logins the hourly audit watches for ungated posts. The operator and ourLogins entries are always included; append the App's bot login here (or to ourLogins).",
      },
      auditOrgs: {
        type: "array",
        items: { type: "string" },
        default: ["router-for-me", "paperclipai"],
        description: "Upstream orgs the audit searches per watched login (authored and commented issues/PRs, authored discussions).",
      },
      auditRepos: {
        type: "array",
        items: { type: "string" },
        default: [],
        description: "Extra upstream repos the audit searches, as owner/repo, for posts outside the configured audit orgs.",
      },
      chiefOfStaffAgentId: {
        type: "string",
        default: "ad0e6eaa-51a3-41dd-97d8-af46a84fc5e9",
        description: "Agent assigned to the Ungated upstream post flag cards (the Chief of Staff).",
      },
      maxCreatesPerTick: {
        type: "integer",
        minimum: 0,
        default: 2,
        description:
          "Per-scan-run cap on created cards (release intake plus follow-through plus discovery). Overflow is deferred to the next tick, never dropped.",
      },
      maxWakesPerTick: {
        type: "integer",
        minimum: 0,
        default: 5,
        description:
          "Per-scan-run cap on wakes. A create assigns an agent, so it counts as a wake too. Overflow is deferred to the next tick, never dropped.",
      },
      parkedPropagationEnabled: {
        type: "boolean",
        default: false,
        description:
          "Parked-blocker propagation (TWO-5818): when a card that blocks others moves to backlog, cancelled, or a NO-GO/deferred disposition, wake each blocked dependent's assignee with the parked root and its revisit trigger (comment + wake only; the plugin never changes a dependent's status, assignee or stages). Off by default.",
      },
      parkedMaxWakesPerEvent: {
        type: "integer",
        minimum: 0,
        default: 25,
        description:
          "Per parked-propagation event/tick cap on propagated dependents. Overflow is queued and drained on the next parked-propagation-scan tick, never dropped.",
      },
    },
  },
};

export default manifest;
