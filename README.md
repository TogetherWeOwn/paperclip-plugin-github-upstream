# paperclip-plugin-github-upstream

A [Paperclip](https://github.com/paperclipai/paperclip) plugin that notices upstream GitHub changes **deterministically, with zero LLM calls**, and only then creates or wakes a Paperclip card. It exists so follow-through work on upstream PRs/issues/discussions and release intake happens because the upstream changed, not because an agent went polling.

Four scheduled jobs do all the noticing:

| job | schedule | what it does |
|---|---|---|
| `release-scan` | `*/10 * * * *` | `GET /repos/{owner}/{repo}/releases/latest` with `If-None-Match` per configured repo. A `304` means do nothing; a new tag creates exactly one release-intake card (`originKind: plugin:togetherweown.github-upstream:release`, `originId: {owner}/{repo}@{tag}`). |
| `item-scan` | `*/15 * * * *` | ETag-conditional `GET`s for every tracked upstream issue/PR (`issues/{n}`, plus `pulls/{n}`, `pulls/{n}/reviews` and `commits/{head}/check-runs` while checks are pending) and one GraphQL query per tracked discussion. On a real change the owning follow-through card is woken with a deterministic one-line reason and idempotency key `upstream:{owner}/{repo}#{n}:{fingerprint}`. |
| `audit-scan` | `11 * * * *` | Hourly upstream-gate audit (see below): deterministic search for recent upstream posts by our account, flagging any post with no approved gate card. This is an audit trail, not a block. |
| `review-guard-scan` | `*/15 * * * *` | Review-guard backstop: every `in_review` card is checked for a live reviewer stage, and code cards without one are stamped via `issues.update` with an audit comment. Staffing is re-tiered per head (TWO-5879): QA on every change and Security before QA whenever the effective tier is Sensitive. Until content triggers can be ruled out with evidence, even low/ordinary path tiers fail closed to Sensitive. The `issue.created`/`issue.updated` event subscriptions handle new cards immediately; the sweep catches missed events and pre-install cards. |

A real change is one of: `updated_at`, comment count, review count, latest review state, check conclusion, head SHA, `state`/`merged`, draft flag. Labels (`gh:repo/*`, `gh:type/*`, `gh:state/*`, `gh:ci/*`, `gh:awaiting/*`) and a `<!-- github-upstream: … -->` description header are synced on change.

Whose court the ball is in is derived deterministically from the snapshot, never fetched separately: closed/merged items need nobody; an open PR that is a draft, has red checks, or has a maintainer requesting changes is awaiting us; an approved open PR waits on the maintainer to merge; any other open ours item waits on the maintainer to respond. Non-ours items never get an awaiting label. Stale `gh:*` label IDs are swept by reverse lookup too, so ID-only read paths cannot accumulate replaced facets. A config or label-map change that flips awaiting with no upstream change syncs the labels/header quietly without waking the card.

Upgrading from 0.1.0: stored snapshots predate the review-state field. The first scan backfills it with one unconditioned reviews read per tracked PR (later scans are `304`s again) and renormalizes the stored fingerprint, so the backfill syncs the new awaiting labels without waking any card.

Our own upstream actions never wake our own card: on a changed fingerprint (never on a `304`) the plugin makes one extra `GET` for the latest actor — `issues/{n}/comments?since=<previous updatedAt>` when the comment count rose, plus `pulls/{n}/commits` when the head moved. If every observed actor is ours (`operatorLogin` plus `ourLogins`), the fingerprint is recorded as woken and the card stays asleep; the header and labels still sync. Anything unattributable still wakes — state changes, new reviews, removed comments, check drift, and discussions (a discussion number is not an issue number, so neither endpoint applies). A check re-run on the same head is not detected while checks are settled; that is acceptable.

## Card mapping

Follow-through owners may sit directly under the tracker or under one program card (tracker → program → item). Both item sync and audit use that same owner set, so explicit `extraTrackedItems` entries and discovery reuse nested cards rather than creating duplicates. A direct child's explicit plugin item origin remains authoritative even when it has ordinary subtasks; those subtasks never become owners. Without an explicit item origin, a direct child is treated as a program only when a non-gate child has its own item identity (plugin origin or unquoted description URL). The identified children then own their items, not the program summary. Ordinary identity-less subtasks do not turn an item into a program.

Gate titles match `Upstream gate` followed by the end of the title, whitespace, or a delimiter (`(`, `:`, `-`, `–`, `—`). They are never owners, and their children and items deeper than one program level are not scanned. Titles such as `Upstream gateway timeout investigation` remain ordinary items and never count as gate evidence. Actual gates under either direct or program-nested owners still count as audit evidence.

When correcting an old summary that was mistakenly mapped as an item, remove its explicit item origin before relying on its nested owner. A changed owner initializes its origin, description header and labels even when the upstream response is unchanged or cached (`304`), without waking it for the ownership correction alone. Dry runs report that sync without modifying the card or consuming the live ownership repair.

An upstream item maps to a card by plugin `originId` (`{owner}/{repo}#{n}`), then by a GitHub URL in the description. **A work product alone is not sufficient:** the host's plugin `getSubtree` returns raw issue rows without work products and has no include-work-products option. Put the canonical issue/PR/discussion URL in an unquoted description line before relying on plugin tracking; attaching a GitHub work product is still useful for navigation but does not establish identity. This contract also applies to dry runs. Existing plugin origins remain valid without a description link (bare origins default to PR and self-correct to issue).

Blockquoted lines are never identity: the plugin quotes the upstream title as untrusted text, and titles can carry arbitrary URLs. Cards found by description URL get `originKind`/`originId` backfilled, but a card that already owns another item never matches by URL. New "ours" items with no card get a follow-through child of the tracker: a PR whose head matches `ourHeadPrefixes` (`TogetherWeOwn:*` by default) or whose author is `operatorLogin`. Issue search discovery (`discoveryQueries`) runs at most hourly and only creates cards for ours items.

## GitHub tab

The plugin contributes a `github` page slot ("GitHub") that renders the SDK's native `IssuesList`, scoped by `filters.originKindPrefix: "plugin:togetherweown.github-upstream:"` with a stable `viewStateKey` (`github-upstream`). Native filter, search, sort and saved views come from the host for free; there is no custom filter bar. One tracking card per upstream item (see Card mapping above) carries the `gh:*` labels and the description header (last upstream activity, comment/review counts), so the list stays current via the `item-scan` sync.

A `MetricCard` row sits above the list: open PRs, red CI, awaiting maintainer, awaiting us. The counts come from a worker-registered `getData` key (`github-upstream-summary`) computed over the tracked-item snapshots, so the tab needs no extra GitHub reads. Known, accepted gap: last activity and comment counts show in the card header, not as sortable columns — sort by the card's updated time instead.

## Upstream-gate audit (`audit-scan`)

The hourly `audit-scan` job is the audit trail for the upstream gate: it flags any upstream item, comment or review posted from our account that has no approved gate card. It cannot block a post; it makes an ungated post visible within one sync cycle.

Detection, with no LLM: per configured org and watched login it searches `org:<o> is:issue author:<login>`, the `is:pull-request` twin, and the `commenter:` twins, all bounded by `updated:>=<last search>`; authored discussions come from one GraphQL `search(type: DISCUSSION)` per org and login, and `auditRepos` covers posts outside the configured orgs. Each candidate item's comments, PR review comments and reviews are then read (ETag-conditional per item) and filtered to watched logins newer than the per-item cursor. Posts before `2026-11-02T00:00Z` are never flagged: the TWO-809 audit cards (TWO-810…TWO-818) already cover them.

A post counts as gated when a `done` card titled `Upstream gate …` sits under the item's follow-through card with approval (`completedAt`) at or before the post's `created_at`. An ungated post labels the follow-through card `upstream:ungated` (creating the card first when it is missing, so a comment on someone else's item still gets one) and opens one `Ungated upstream post: <owner>/<repo>#<n>` card for the Chief of Staff with the post URL, timestamp and author, woken with idempotency key `ungated:<post-url>`. Repeat runs cannot double-flag: per-item cursors plus the recorded flag keys dedupe.

Known, accepted gaps: the plugin SDK exposes no execution-decision reads, so v1 checks `status == done` plus the parent link (using `completedAt` as the approval time) instead of verifying both review stages — see TWO-819 for the SDK gap note. Discussion comments on untracked threads have no search coverage (the discussion search has no `commenter:` qualifier), so only authored discussions and comments on tracked/candidate discussions are audited. Search reads the first page per query (updated-desc, 100 rows); a failed or overflowing page holds the search watermark instead of silently dropping items. Discussion threads read the first 100 comments / 50 replies per thread and comment lists cap at 10 pages; deeper threads are recorded as errors, not silently skipped. Failed item or thread reads never advance cursors or ETags past unread posts: the run is retried with the old read positions.

## Rate limits

Every REST read is ETag-conditional: unchanged answers are `304`s that cost no quota. Check-run reads stop once checks settle. Search has no `304` path, so the audit makes a bounded set of search calls per run (orgs × logins × 4, plus one GraphQL discussion search each) and ETag-conditional per-item reads after that. The plugin honors `X-RateLimit-Remaining`/`Retry-After`, backs off into plugin state, and records per-run `200`/`304` counts so the operator can see the sync costs nearly nothing. It never calls the CLIProxy management API (the HTTP layer only allows `api.github.com`).

## Review-guard (no `in_review` card without a reviewer)

There is no project/company default `executionPolicy` in Paperclip: a code card created without review stages sits in `in_review` with no reviewer, and at 2026-11-11 00:05Z that held for 17 of 114 `in_review` cards. The review-guard closes that gap deterministically, with zero LLM calls, at two speeds:

- **Events (immediate):** the plugin subscribes to `issue.created` and `issue.updated` (`events.subscribe`). A card bound to a project workspace (a repo) that is created or updated with no live reviewer stage is stamped via `issues.update` (`executionPolicy`: `normal` mode, one `review` stage per configured reviewer agent, in order) and gets an audit comment: `Default review policy applied by review-guard: …`. Cards created as code work are stamped at creation, so the policy is already present when they reach `in_review`.
- **Sweep (backstop):** `review-guard-scan` every 15 minutes lists `in_review` cards and stamps any code card still missing stages — covering missed events and cards that predate the install. Idempotence is structural: a card with stages (or `auto` mode, an explicit opt-out) is never touched, so the guard's own `issues.update` re-event is a no-op, and the `review-guard.applied` state record dedupes the audit comment across event/sweep races.
- **Risk tiers (TWO-5879):** staffing varies by the card's changed paths, classified against the repo's `.github/review-tiers.yml` (`low` / `ordinary` / `sensitive` glob lists; sensitive > ordinary > low). QA runs on every tier; Security is added (Security → QA) for Sensitive/unknown. Path classification alone cannot establish that semantic content triggers are absent, so low and ordinary path tiers currently fail closed to Sensitive too. The tier is recomputed on every head, so a QA-only card is upgraded (Security stages prepended, existing stage IDs preserved) and the upgrade audit-commented; a pending Security stage is never downgraded when a later head tiers lower. Anything the guard cannot classify tiers Sensitive, never less: no workspace checkout, a missing or malformed tier map, an unreadable diff, an unmapped path (new files included), or an edit to `.github/review-tiers.yml` itself. Role staffing is explicit via `reviewQaAgentIds` / `reviewSecurityAgentIds` (plus per-project overrides); when they are unset, the legacy `defaultReviewAgentIds` chain splits by position (first ID Security, rest QA), so existing installs keep their Sensitive staffing. A Sensitive head with no usable Security reviewer fails closed (no stamp) instead of downgrading to QA-only. Changed paths come from read-only `git` (merge-base, `diff --name-only`, `ls-files --others`) in the host-provided checkout — never a shell, and any git failure tiers Sensitive.

**Conservative staffing and exit:** all resolved changes currently require Security, including unmatched paths and low/ordinary paths whose content triggers cannot be proven absent. When configured staffing has no eligible Security reviewer, the guard withholds the policy and posts an audit comment; it does not substitute QA-only or permit self-review. This can leave a card without reviewers until eligible Security staffing is provided. Return to tiered staffing requires an independently reviewed and tested enforcement mechanism establishing absence of every canonical content trigger, including weakened tests, while preserving uncertainty escalation, sensitive floors, highest-tier selection and no downgrade, followed by the normal Security, QA and release gates.

The guard is off by default and fails closed without reviewer configuration: it never invents a reviewer. To enable at install, set `reviewGuardEnabled: true`, `defaultReviewAgentIds: [<Security agent ID>, <QA agent ID>]`, and optionally `reviewAgentIdsByProjectId` for per-project chains; turn on `reviewGuardDryRun` first to watch the logs. This is a plugin-tier fix (stock SDK, no core patch): the stock SDK's `issues.update` wire protocol freezes the patch as `Record<string, unknown>` and the host `updateIssueSchema` accepts `executionPolicy` (only `createdByUserId`/`responsibleUserId`/`watchdog` are omitted from the create base), while the SDK's typed `Pick<Issue, …>` is a creator-subset — the single cast is cited in `src/review-guard.ts`.

## Authentication

Exactly one auth mode must be configured; anything else fails the scan closed (no anonymous reads, ever):

- **GitHub App (preferred):** set `appId`, `installationId` and `appPrivateKeySecretRef`. Each scan signs a short RS256 JWT from the private key (resolved at call time, never logged or persisted), exchanges it for a 1-hour installation token with an empty permissions subset, and uses that token for every REST/GraphQL read. Tokens live in process memory only and refresh 5 minutes before `expires_at`. The only outbound host is `api.github.com`.
- **Personal token:** set `tokenSecretRef` to the `{ type: "secret_ref", secretId }` binding of a read-only token. Only the ref is stored; the token value is never logged.

## Configuration

| key | default | meaning |
|---|---|---|
| `tokenSecretRef` | `null` | Company secret binding for a read-only GitHub token (PAT auth mode). Only the ref is stored; the token value is never logged. |
| `appId` | `""` | GitHub App auth mode: the numeric App ID, as a string. |
| `installationId` | `""` | GitHub App auth mode: the numeric installation ID, as a string. |
| `appPrivateKeySecretRef` | `null` | GitHub App auth mode: company secret binding for the App's PEM private key. Resolved at call time only, never logged or persisted. |
| `releaseRepos` | `["router-for-me/CLIProxyAPI", "paperclipai/paperclip"]` | Upstream repos whose latest release is tracked. |
| `releaseIntakeAssigneeAgentId` | Release Manager | Owner of release-intake cards. |
| `releaseIntakeProjectId` | `""` | Project for release-intake cards. Empty means no project. |
| `followThroughTrackerIssueId` | `""` | Tracker card whose subtree holds one follow-through card per upstream item. Empty disables item tracking. |
| `followThroughAssigneeAgentId` | Software Engineer 1 | Default owner of newly created follow-through cards. |
| `ourHeadPrefixes` | `["TogetherWeOwn:"]` | PR head labels that count as ours. |
| `operatorLogin` | `""` | GitHub login of the operator; their authored items count as ours. |
| `ourLogins` | `[]` | Extra GitHub logins that count as ours (e.g. the coming bot identity). |
| `extraTrackedItems` | `[]` | Upstream items to track in addition to the tracker subtree. |
| `discoveryQueries` | `[]` | Issue-search queries for discovering new ours items (hourly at most). Empty disables discovery. |
| `compareBases` | `{}` | Per-repo compare base for release cards, keyed by `owner/repo`. A first-seen tag equal to the base is the install baseline: recorded, never carded. Set it to the running versions at install so the first tick creates no intake cards. |
| `labelIdByName` | `{}` | Paperclip label IDs keyed by name. Only names present here can be synced (there is no labels read API). Include the `gh:awaiting/us` and `gh:awaiting/maintainer` IDs for the awaiting facet and the GitHub-tab metric counts to stay in sync, plus the `upstream:ungated` ID or the audit cannot label follow-through cards. |
| `dryRun` | `false` | Log intended creates/wakes/updates without making them. |
| `reviewGuardEnabled` | `false` | Review-guard: stamp default review stages onto code cards reaching `in_review` (or created as code work) without a live reviewer. Off by default. |
| `reviewGuardDryRun` | `false` | Review-guard dry-run: log intended stamps and audit comments without making them. |
| `defaultReviewAgentIds` | `[]` | Review-guard: legacy reviewer chain (agent IDs, in stage order, e.g. Security then QA). Empty means the guard never writes that company's cards. When the tiered role lists below are unset, this chain splits by position (first ID Security, rest QA). |
| `reviewAgentIdsByProjectId` | `{}` | Review-guard: per-project reviewer chain overrides, keyed by project ID; a project entry wins over `defaultReviewAgentIds` for that project's cards (split by position when tiered roles are unset). |
| `reviewQaAgentIds` | `[]` | Review-guard (TWO-5879): QA reviewer stage participants, on every tier. When set, wins over the legacy chain's positional split; when empty, that split applies. |
| `reviewQaAgentIdsByProjectId` | `{}` | Review-guard (TWO-5879): per-project QA reviewer overrides, keyed by project ID. |
| `reviewSecurityAgentIds` | `[]` | Review-guard (TWO-5879): Security reviewer stage participants, added for Sensitive/unknown tiers (Security then QA); low/ordinary paths currently also fail closed to Sensitive because content triggers cannot be ruled out. When set, wins over the positional split; when empty, that split applies. With no usable Security reviewer a Sensitive card fails closed instead of downgrading to QA-only. |
| `reviewSecurityAgentIdsByProjectId` | `{}` | Review-guard (TWO-5879): per-project Security reviewer overrides, keyed by project ID. |
| `auditLogins` | `["Rick7C2"]` | GitHub logins the audit watches. `operatorLogin` and `ourLogins` are always included; append the App's bot login here (or to `ourLogins`). |
| `auditOrgs` | `["router-for-me", "paperclipai"]` | Upstream orgs the audit searches per watched login. |
| `auditRepos` | `[]` | Extra upstream repos (`owner/repo`) searched outside the audit orgs. |
| `chiefOfStaffAgentId` | Chief of Staff | Owner of the `Ungated upstream post` flag cards. |
| `maxCreatesPerTick` | `2` | Per-scan-run cap on created cards. Overflow is deferred to the next tick, never dropped. |
| `maxWakesPerTick` | `5` | Per-scan-run cap on wakes (a create counts as a wake too). Overflow is deferred to the next tick, never dropped. |
| `parkedPropagationEnabled` | `false` | Parked-blocker propagation (TWO-5818). Off by default; see below. |
| `parkedMaxWakesPerEvent` | `25` | Per parked-propagation event/tick cap on propagated dependents. Overflow is queued for the next sweep tick, never dropped. |

## Parked-blocker propagation (`parkedPropagationEnabled`)

When enabled, the plugin subscribes to `issue.updated` (the same subscription as the review-guard): when a card that blocks others is parked — moved to `backlog` or `cancelled`, or marked NO-GO/deferred in its title/description — each blocked dependent's assignee is woken with the parked root and its revisit trigger, so the dependent is re-dispositioned instead of staying `blocked` forever.

The revisit trigger is derived deterministically from the root: a `revisit:`/`unblocks when:`/`checkpoint:`/`review on:` line in the description, then `monitorNextCheckAt`, then the unblock descriptor action, and honestly reported as absent when none exists. Dependents are enumerated with `issues.relations.get` (`blocks`). Each non-terminal dependent gets one marker-guarded audit comment plus a wake, deduplicated per (root transition, dependent): a re-park to a different parked status opens a new transition, and un-parking closes the window. Terminal (`done`/`cancelled`/`archived`) dependents are skipped, and a dependent with no agent assignee still gets the audit comment but no wake. Fan-out past `parkedMaxWakesPerEvent` is queued and drained by the `parked-propagation-scan` job (`*/15`), which re-validates each entry (root still parked, dependent non-terminal) and gives up after 3 attempts. The plugin never calls `issues.update` on dependents: no status, assignee or stage is ever changed by propagation, and its own writes never park anything, so its events cannot loop back into propagation.

Known SDK gap (worked around, not bypassed): `issues.requestWakeup` is tried first but the host refuses to wake a card with unresolved blockers — any `blockedBy` entry not `done` — and a parked root is by definition not `done`, so the issue-scoped wake always throws for freshly parked dependents (the test-harness mirror throws `Issue is blocked by unresolved blockers`, and likewise refuses `backlog`/`done`/`cancelled` dependents). The plugin therefore falls back to `agents.invoke`, which checks only the agent's own status and actually wakes the blocked assignee with the parked root, its revisit trigger and a re-disposition instruction. Plugin-attributed comments never wake anyone (SDK contract), which is why the comment alone is not the wake.

`dryRun` also covers propagation: with it set, the event handler logs and writes nothing.

## Capabilities

`companies.read`, `issues.read`, `issue.subtree.read`, `issues.create`, `issues.update`, `issue.comments.create`, `issues.wakeup`, `jobs.schedule`, `http.outbound`, `secrets.read-ref`, `plugin.state.read`, `plugin.state.write`, `events.subscribe`, `agent.tools.register`, `ui.page.register`, `project.workspaces.read`, `execution.workspaces.read`, `issue.relations.read`, `issue.comments.read`, `agents.invoke`.

## Agent tools

- `defer_blocked_card` — move one `blocked` card to `backlog` under plugin authority for an already-decided deferral the native resume guard blocks. Inputs: `targetIssueId` (the blocked card), `decisionIssueId` (a `done` decision card whose title/description/comments name the target), `revisitTrigger` (the observable revisit event or UTC date). The caller is bound via the SDK's `ToolRunContext` (`agentId`/`runId`) and recorded as the issue-update actor; an audit comment on the target records caller, decision ref and revisit trigger. The update patch is status-only, so blocker edges, review stages and monitors are untouched; terminal cards and cards with a pending review stage are refused. Idempotent: a target already in `backlog` returns success without a new update or comment.

## Dry run

`bin/github-upstream-dryrun.mjs` runs all three jobs end to end against the real GitHub API with a file-backed state store and a stub Paperclip client. Nothing is created, woken or updated; the token comes from `GITHUB_TOKEN` or `--token-file`, never from config. Run it twice with the same `--state` file: the second run is mostly `304`s and reports the same intentions (the audit persists no cursors in dry-run, so it re-reports honestly).

```sh
GITHUB_TOKEN=$(cat ~/.paperclip/github-upstream-token) \
paperclip-github-upstream-dryrun \
  --cards ./cards.json --config ./config.json --state ./dryrun-state.json
```

`cards.json` holds tracker descendants (including program containers and gate cards) reduced to `{id, title, parentId, originKind, originId, labels, labelIds, description, assigneeAgentId, status, completedAt, identifier}`. Preserve parent links and gate titles so owner selection and audit evidence match production; `workProducts` are ignored for identity. Pass `--tracker-id <id>` when program nesting makes automatic parent inference ambiguous. Dry-run intentions are printed as one JSON object per line.

## Development

```sh
npm ci
npm run check   # typecheck, tests, build
```

## License

MIT
