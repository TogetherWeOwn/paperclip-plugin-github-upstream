export type TrackedKind = "issue" | "pull" | "discussion";

export interface TrackedItemRef {
  owner: string;
  repo: string;
  kind: TrackedKind;
  number: number;
}

export interface UpstreamConfig {
  tokenSecretRef: unknown;
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
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : [];

const stringMap = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  return out;
};

const isTrackedItemRef = (value: unknown): value is TrackedItemRef => {
  if (!isRecord(value)) return false;
  return (
    typeof value.owner === "string" &&
    typeof value.repo === "string" &&
    (value.kind === "issue" || value.kind === "pull" || value.kind === "discussion") &&
    typeof value.number === "number" &&
    Number.isInteger(value.number) &&
    value.number > 0
  );
};

/** Resolve operator config with the documented defaults. Unknown keys are ignored. */
export function resolveConfig(raw: Record<string, unknown>): UpstreamConfig {
  const releaseRepos = stringArray(raw.releaseRepos);
  const extra = Array.isArray(raw.extraTrackedItems) ? raw.extraTrackedItems.filter(isTrackedItemRef) : [];
  return {
    tokenSecretRef: raw.tokenSecretRef ?? null,
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
    compareBases: stringMap(raw.compareBases),
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
  };
}

/** "owner/repo" key used for state keys, origin IDs and labels. */
export const repoKey = (owner: string, repo: string): string => `${owner}/${repo}`;

export const itemKey = (item: Pick<TrackedItemRef, "owner" | "repo" | "number">): string =>
  `${repoKey(item.owner, item.repo)}#${item.number}`;

export const releaseKey = (owner: string, repo: string, tag: string): string =>
  `${repoKey(owner, repo)}@${tag}`;
