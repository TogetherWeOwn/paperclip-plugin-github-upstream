import type { EnvSecretRefBinding } from "@paperclipai/plugin-sdk";

export type TrackedKind = "issue" | "pull" | "discussion";

export interface TrackedItemRef {
  owner: string;
  repo: string;
  kind: TrackedKind;
  number: number;
}

export interface UpstreamConfig {
  /** Company secret binding for the GitHub token. Null means unconfigured: scans fail closed, never anonymous. */
  tokenSecretRef: EnvSecretRefBinding | null;
  /**
   * Review-guard (TWO-5794): stamp the default review stages onto code cards
   * that reach `in_review` (or are created as code work) without a live
   * reviewer stage. Off by default; enabling also needs checkout of the
   * reviewer agent IDs below, or the guard stays a no-op for that company.
   */
  reviewGuardEnabled: boolean;
  /** Review-guard dry-run: log intended `issues.update` + audit comments without making them. */
  reviewGuardDryRun: boolean;
  /**
   * Default review stage participants (agent IDs, in stage order), e.g.
   * Security then QA. Empty means the guard never writes that company's
   * cards: it never invents a reviewer.
   */
  defaultReviewAgentIds: string[];
  /** Per-project review stage participants (project ID -> agent IDs), overriding `defaultReviewAgentIds`. */
  reviewAgentIdsByProjectId: Record<string, string[]>;
  /**
   * GitHub App auth (preferred over `tokenSecretRef`): the numeric App ID, as
   * a string. Empty means App auth is not configured.
   */
  appId: string;
  /**
   * GitHub App auth: the numeric installation ID on TogetherWeOwn, as a
   * string. Empty means App auth is not configured.
   */
  installationId: string;
  /** Company secret binding for the App's PEM private key. Null means App auth is not configured. */
  appPrivateKeySecretRef: EnvSecretRefBinding | null;
  releaseRepos: string[];
  releaseIntakeAssigneeAgentId: string;
  releaseIntakeProjectId: string;
  followThroughTrackerIssueId: string;
  followThroughAssigneeAgentId: string;
  ourHeadPrefixes: string[];
  operatorLogin: string;
  /** Extra GitHub logins that count as ours (e.g. a bot identity). */
  ourLogins: string[];
  extraTrackedItems: TrackedItemRef[];
  discoveryQueries: string[];
  compareBases: Record<string, string>;
  labelIdByName: Record<string, string>;
  dryRun: boolean;
  /** GitHub logins the audit watches for ungated posts. The operator and ourLogins identities are always included. */
  auditLogins: string[];
  /** Upstream orgs the audit searches per watched login. */
  auditOrgs: string[];
  /** Extra upstream repos the audit searches, as owner/repo (outside auditOrgs). */
  auditRepos: string[];
  /** Owner of the "Ungated upstream post" flag cards. */
  chiefOfStaffAgentId: string;
  /** Per-scan-run spend caps. A create also assigns an agent, so it counts as a wake too. */
  maxCreatesPerTick: number;
  maxWakesPerTick: number;
}

export const DEFAULT_RELEASE_REPOS = ["router-for-me/CLIProxyAPI", "paperclipai/paperclip"];
export const DEFAULT_RELEASE_INTAKE_ASSIGNEE = "c4bd17fa-72df-43b4-83cd-df59ec7de5d0";
export const DEFAULT_FOLLOW_THROUGH_ASSIGNEE = "7b8f576c-ebce-447f-a904-dda322df4220";
export const DEFAULT_HEAD_PREFIXES = ["TogetherWeOwn:"];
export const DEFAULT_AUDIT_LOGINS = ["Rick7C2"];
export const DEFAULT_AUDIT_ORGS = ["router-for-me", "paperclipai"];
export const DEFAULT_CHIEF_OF_STAFF_ASSIGNEE = "ad0e6eaa-51a3-41dd-97d8-af46a84fc5e9";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((v): v is string => typeof v === "string" && v.length > 0))]
    : [];

const stringMap = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  return out;
};

/** Project ID -> agent IDs (review-guard per-project override). Non-array entries and empty keys are dropped. */
const stringArrayMap = (value: unknown): Record<string, string[]> => {
  if (!isRecord(value)) return {};
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(value)) {
    const ids = stringArray(v);
    if (k.length > 0 && ids.length > 0) out[k] = ids;
  }
  return out;
};

/** GitHub owner and repo segments: letters, digits, dot, underscore, dash. Card text that parses to anything else never steers an API call. */
export const OWNER_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

export const isValidOwnerRepo = (owner: string, repo: string): boolean =>
  OWNER_REPO_RE.test(owner) && OWNER_REPO_RE.test(repo);

/** Git tags may technically contain almost anything; the plugin only accepts a safe subset for card titles and bodies. */
export const RELEASE_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._+\-/]{0,99}$/;

export const isValidReleaseTag = (tag: string): boolean => RELEASE_TAG_RE.test(tag);

const isTrackedItemRef = (value: unknown): value is TrackedItemRef => {
  if (!isRecord(value)) return false;
  return (
    typeof value.owner === "string" &&
    typeof value.repo === "string" &&
    isValidOwnerRepo(value.owner, value.repo) &&
    (value.kind === "issue" || value.kind === "pull" || value.kind === "discussion") &&
    typeof value.number === "number" &&
    Number.isInteger(value.number) &&
    value.number > 0
  );
};

const isSecretRefBinding = (value: unknown): value is EnvSecretRefBinding => {
  if (!isRecord(value)) return false;
  return (
    value.type === "secret_ref" &&
    typeof value.secretId === "string" &&
    value.secretId.length > 0
  );
};

const intOr = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;

export const DEFAULT_MAX_CREATES_PER_TICK = 2;
export const DEFAULT_MAX_WAKES_PER_TICK = 5;

/**
 * GitHub numeric IDs (App ID, installation ID): digits only, so a pasted
 * client ID or slug fails closed instead of steering the token-mint path.
 */
export const GITHUB_NUMERIC_ID_RE = /^[0-9]{1,20}$/;

const numericId = (value: unknown): string => {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && GITHUB_NUMERIC_ID_RE.test(value.trim())) return value.trim();
  // Present but malformed: keep the raw trimmed text so validation reports it
  // instead of silently treating the mode as unset.
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return "";
};

/**
 * Validate the auth-mode selection. Exactly one mode must be set: either the
 * PAT binding (`tokenSecretRef`) or the full GitHub App triple (`appId`,
 * `installationId`, `appPrivateKeySecretRef`). Returns an error message, or
 * null when the selection is valid.
 */
export function validateAuthConfig(config: Pick<UpstreamConfig, "tokenSecretRef" | "appId" | "installationId" | "appPrivateKeySecretRef">): string | null {
  const patSet = config.tokenSecretRef !== null;
  const appFields = [config.appId, config.installationId, config.appPrivateKeySecretRef !== null ? "set" : ""];
  const appSet = appFields.some((f) => f.length > 0);
  if (patSet && appSet) {
    return "cannot set both tokenSecretRef and GitHub App auth (appId/installationId/appPrivateKeySecretRef): choose exactly one auth mode";
  }
  if (!patSet && !appSet) {
    return "no GitHub auth configured: set tokenSecretRef or all of appId, installationId and appPrivateKeySecretRef";
  }
  if (appSet) {
    const missing = [
      config.appId ? null : "appId",
      config.installationId ? null : "installationId",
      config.appPrivateKeySecretRef ? null : "appPrivateKeySecretRef",
    ].filter((v): v is string => v !== null);
    if (missing.length > 0) {
      return `incomplete GitHub App auth: missing ${missing.join(", ")} (appId, installationId and appPrivateKeySecretRef are all required)`;
    }
    if (!GITHUB_NUMERIC_ID_RE.test(config.appId)) return `invalid GitHub App auth: appId must be the numeric App ID, got ${JSON.stringify(config.appId)}`;
    if (!GITHUB_NUMERIC_ID_RE.test(config.installationId)) {
      return `invalid GitHub App auth: installationId must be the numeric installation ID, got ${JSON.stringify(config.installationId)}`;
    }
  }
  return null;
}

/** Resolve operator config with the documented defaults. Unknown keys are ignored. */
export function resolveConfig(raw: Record<string, unknown>): UpstreamConfig {
  const releaseRepos = stringArray(raw.releaseRepos);
  const extra = Array.isArray(raw.extraTrackedItems) ? raw.extraTrackedItems.filter(isTrackedItemRef) : [];
  // Compare bases are keyed by owner/repo: normalize the case so lookups hit.
  const bases: Record<string, string> = {};
  for (const [k, v] of Object.entries(stringMap(raw.compareBases))) {
    bases[k.toLowerCase()] = v;
  }
  return {
    tokenSecretRef: isSecretRefBinding(raw.tokenSecretRef) ? raw.tokenSecretRef : null,
    reviewGuardEnabled: raw.reviewGuardEnabled === true,
    reviewGuardDryRun: raw.reviewGuardDryRun === true,
    defaultReviewAgentIds: stringArray(raw.defaultReviewAgentIds),
    reviewAgentIdsByProjectId: stringArrayMap(raw.reviewAgentIdsByProjectId),
    appId: numericId(raw.appId),
    installationId: numericId(raw.installationId),
    appPrivateKeySecretRef: isSecretRefBinding(raw.appPrivateKeySecretRef) ? raw.appPrivateKeySecretRef : null,
    releaseRepos: releaseRepos.length > 0 ? releaseRepos : [...DEFAULT_RELEASE_REPOS],
    releaseIntakeAssigneeAgentId:
      typeof raw.releaseIntakeAssigneeAgentId === "string" && raw.releaseIntakeAssigneeAgentId.length > 0
        ? raw.releaseIntakeAssigneeAgentId
        : DEFAULT_RELEASE_INTAKE_ASSIGNEE,
    releaseIntakeProjectId:
      typeof raw.releaseIntakeProjectId === "string" ? raw.releaseIntakeProjectId : "",
    followThroughTrackerIssueId:
      typeof raw.followThroughTrackerIssueId === "string" ? raw.followThroughTrackerIssueId : "",
    followThroughAssigneeAgentId:
      typeof raw.followThroughAssigneeAgentId === "string" && raw.followThroughAssigneeAgentId.length > 0
        ? raw.followThroughAssigneeAgentId
        : DEFAULT_FOLLOW_THROUGH_ASSIGNEE,
    ourHeadPrefixes: (() => {
      const prefixes = stringArray(raw.ourHeadPrefixes);
      return prefixes.length > 0 ? prefixes : [...DEFAULT_HEAD_PREFIXES];
    })(),
    operatorLogin: typeof raw.operatorLogin === "string" ? raw.operatorLogin.trim() : "",
    ourLogins: stringArray(raw.ourLogins),
    extraTrackedItems: extra,
    discoveryQueries: stringArray(raw.discoveryQueries),
    compareBases: bases,
    labelIdByName: stringMap(raw.labelIdByName),
    dryRun: raw.dryRun === true,
    auditLogins: (() => {
      const logins = stringArray(raw.auditLogins);
      return logins.length > 0 ? logins : [...DEFAULT_AUDIT_LOGINS];
    })(),
    auditOrgs: (() => {
      const orgs = stringArray(raw.auditOrgs);
      return orgs.length > 0 ? orgs : [...DEFAULT_AUDIT_ORGS];
    })(),
    auditRepos: stringArray(raw.auditRepos),
    chiefOfStaffAgentId:
      typeof raw.chiefOfStaffAgentId === "string" && raw.chiefOfStaffAgentId.length > 0
        ? raw.chiefOfStaffAgentId
        : DEFAULT_CHIEF_OF_STAFF_ASSIGNEE,
    maxCreatesPerTick: intOr(raw.maxCreatesPerTick, DEFAULT_MAX_CREATES_PER_TICK),
    maxWakesPerTick: intOr(raw.maxWakesPerTick, DEFAULT_MAX_WAKES_PER_TICK),
  };
}

/**
 * "owner/repo" key used for state keys, origin IDs and labels. GitHub owner and
 * repo names are case-insensitive, so keys always use the lowercase form while
 * snapshots keep the canonical case for display.
 */
export const repoKey = (owner: string, repo: string): string => `${owner.toLowerCase()}/${repo.toLowerCase()}`;

export const itemKey = (item: Pick<TrackedItemRef, "owner" | "repo" | "number">): string =>
  `${repoKey(item.owner, item.repo)}#${item.number}`;

export const releaseKey = (owner: string, repo: string, tag: string): string =>
  `${repoKey(owner, repo)}@${tag}`;
