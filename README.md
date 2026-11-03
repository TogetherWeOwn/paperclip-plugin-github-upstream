# paperclip-plugin-github-upstream

A [Paperclip](https://github.com/paperclipai/paperclip) plugin that notices upstream GitHub changes **deterministically, with zero LLM calls**, and only then creates or wakes a Paperclip card. It exists so follow-through work on upstream PRs/issues/discussions and release intake happens because the upstream changed, not because an agent went polling.

Three scheduled jobs do all the noticing:

| job | schedule | what it does |
|---|---|---|
| `release-scan` | `*/10 * * * *` | `GET /repos/{owner}/{repo}/releases/latest` with `If-None-Match` per configured repo. A `304` means do nothing; a new tag creates exactly one release-intake card (`originKind: plugin:togetherweown.github-upstream:release`, `originId: {owner}/{repo}@{tag}`). |
| `item-scan` | `*/15 * * * *` | ETag-conditional `GET`s for every tracked upstream issue/PR (`issues/{n}`, plus `pulls/{n}`, `pulls/{n}/reviews` and `commits/{head}/check-runs` while checks are pending) and one GraphQL query per tracked discussion. On a real change the owning follow-through card is woken with a deterministic one-line reason and idempotency key `upstream:{owner}/{repo}#{n}:{fingerprint}`. |
| `audit-scan` | `11 * * * *` | Hourly upstream-gate audit (see below): deterministic search for recent upstream posts by our account, flagging any post with no approved gate card. This is an audit trail, not a block. |

A real change is one of: `updated_at`, comment count, review count, latest review state, check conclusion, head SHA, `state`/`merged`, draft flag. Labels (`gh:repo/*`, `gh:type/*`, `gh:state/*`, `gh:ci/*`, `gh:awaiting/*`) and a `<!-- github-upstream: … -->` description header are synced on change.

Whose court the ball is in is derived deterministically from the snapshot, never fetched separately: closed/merged items need nobody; an open PR that is a draft, has red checks, or has a maintainer requesting changes is awaiting us; an approved open PR waits on the maintainer to merge; any other open ours item waits on the maintainer to respond. Non-ours items never get an awaiting label. Stale `gh:*` label IDs are swept by reverse lookup too, so ID-only read paths cannot accumulate replaced facets. A config or label-map change that flips awaiting with no upstream change syncs the labels/header quietly without waking the card.

Upgrading from 0.1.0: stored snapshots predate the review-state field. The first scan backfills it with one unconditioned reviews read per tracked PR (later scans are `304`s again) and renormalizes the stored fingerprint, so the backfill syncs the new awaiting labels without waking any card.

Our own upstream actions never wake our own card: on a changed fingerprint (never on a `304`) the plugin makes one extra `GET` for the latest actor — `issues/{n}/comments?since=<previous updatedAt>` when the comment count rose, plus `pulls/{n}/commits` when the head moved. If every observed actor is ours (`operatorLogin` plus `ourLogins`), the fingerprint is recorded as woken and the card stays asleep; the header and labels still sync. Anything unattributable still wakes — state changes, new reviews, removed comments, check drift, and discussions (a discussion number is not an issue number, so neither endpoint applies). A check re-run on the same head is not detected while checks are settled; that is acceptable.

## Card mapping

Follow-through owners may sit directly under the tracker or under one program card (tracker → program → item). Both item sync and audit use that same owner set, so explicit `extraTrackedItems` entries and discovery reuse nested cards rather than creating duplicates. A direct child with any non-gate children is treated as a program container, not an item owner; URLs in its summary cannot steal its children's identity. Cards titled `Upstream gate…` are never owners, and their children and items deeper than one program level are not scanned. Gates under either direct or program-nested owners still count as audit evidence.

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
| `auditLogins` | `["Rick7C2"]` | GitHub logins the audit watches. `operatorLogin` and `ourLogins` are always included; append the App's bot login here (or to `ourLogins`). |
| `auditOrgs` | `["router-for-me", "paperclipai"]` | Upstream orgs the audit searches per watched login. |
| `auditRepos` | `[]` | Extra upstream repos (`owner/repo`) searched outside the audit orgs. |
| `chiefOfStaffAgentId` | Chief of Staff | Owner of the `Ungated upstream post` flag cards. |
| `maxCreatesPerTick` | `2` | Per-scan-run cap on created cards. Overflow is deferred to the next tick, never dropped. |
| `maxWakesPerTick` | `5` | Per-scan-run cap on wakes (a create counts as a wake too). Overflow is deferred to the next tick, never dropped. |

## Capabilities

`companies.read`, `issues.read`, `issue.subtree.read`, `issues.create`, `issues.update`, `issues.wakeup`, `jobs.schedule`, `http.outbound`, `secrets.read-ref`, `plugin.state.read`, `plugin.state.write`, `ui.page.register`.

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
