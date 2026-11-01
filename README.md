# paperclip-plugin-github-upstream

A [Paperclip](https://github.com/paperclipai/paperclip) plugin that notices upstream GitHub changes **deterministically, with zero LLM calls**, and only then creates or wakes a Paperclip card. It exists so follow-through work on upstream PRs/issues/discussions and release intake happens because the upstream changed, not because an agent went polling.

Two scheduled jobs do all the noticing:

| job | schedule | what it does |
|---|---|---|
| `release-scan` | `*/10 * * * *` | `GET /repos/{owner}/{repo}/releases/latest` with `If-None-Match` per configured repo. A `304` means do nothing; a new tag creates exactly one release-intake card (`originKind: plugin:togetherweown.github-upstream:release`, `originId: {owner}/{repo}@{tag}`). |
| `item-scan` | `*/15 * * * *` | ETag-conditional `GET`s for every tracked upstream issue/PR (`issues/{n}`, plus `pulls/{n}`, `pulls/{n}/reviews` and `commits/{head}/check-runs` while checks are pending) and one GraphQL query per tracked discussion. On a real change the owning follow-through card is woken with a deterministic one-line reason and idempotency key `upstream:{owner}/{repo}#{n}:{fingerprint}`. |

A real change is one of: `updated_at`, comment count, review count, latest review state, check conclusion, head SHA, `state`/`merged`, draft flag. Labels (`gh:repo/*`, `gh:type/*`, `gh:state/*`, `gh:ci/*`, `gh:awaiting/*`) and a `<!-- github-upstream: … -->` description header are synced on change.

Whose court the ball is in is derived deterministically from the snapshot, never fetched separately: closed/merged items need nobody; an open PR that is a draft, has red checks, or has a maintainer requesting changes is awaiting us; an approved open PR waits on the maintainer to merge; any other open ours item waits on the maintainer to respond. Non-ours items never get an awaiting label. Stale `gh:*` label IDs are swept by reverse lookup too, so ID-only read paths cannot accumulate replaced facets.

Our own upstream actions never wake our own card: on a changed fingerprint (never on a `304`) the plugin makes one extra `GET` for the latest actor — `issues/{n}/comments?since=<previous updatedAt>` when the comment count rose, plus `pulls/{n}/commits` when the head moved. If every observed actor is ours (`operatorLogin` plus `ourLogins`), the fingerprint is recorded as woken and the card stays asleep; the header and labels still sync. Anything unattributable still wakes — state changes, new reviews, removed comments, check drift, and discussions (a discussion number is not an issue number, so neither endpoint applies). A check re-run on the same head is not detected while checks are settled; that is acceptable.

## Card mapping

An upstream item maps to a card by `originId` (`{owner}/{repo}#{n}`), then by a GitHub URL work product, then by a GitHub URL in the description (the shape most existing follow-through cards are in). Cards found by URL get `originKind`/`originId` backfilled. New "ours" items with no card get a follow-through child of the tracker: a PR whose head matches `ourHeadPrefixes` (`TogetherWeOwn:*` by default) or whose author is `operatorLogin`. Issue search discovery (`discoveryQueries`) runs at most hourly and only creates cards for ours items.

## GitHub tab

The plugin contributes a `github` page slot ("GitHub") that renders the SDK's native `IssuesList`, scoped by `filters.originKindPrefix: "plugin:togetherweown.github-upstream:"` with a stable `viewStateKey` (`github-upstream`). Native filter, search, sort and saved views come from the host for free; there is no custom filter bar. One tracking card per upstream item (see Card mapping above) carries the `gh:*` labels and the description header (last upstream activity, comment/review counts), so the list stays current via the `item-scan` sync.

A `MetricCard` row sits above the list: open PRs, red CI, awaiting maintainer, awaiting us. The counts come from a worker-registered `getData` key (`github-upstream-summary`) computed over the tracked-item snapshots, so the tab needs no extra GitHub reads. Known, accepted gap: last activity and comment counts show in the card header, not as sortable columns — sort by the card's updated time instead.

## Rate limits

Every REST read is ETag-conditional: unchanged answers are `304`s that cost no quota. Check-run reads stop once checks settle. The plugin honors `X-RateLimit-Remaining`/`Retry-After`, backs off into plugin state, and records per-run `200`/`304` counts so the operator can see the sync costs nearly nothing. It never calls the CLIProxy management API (the HTTP layer only allows `api.github.com`).

## Configuration

| key | default | meaning |
|---|---|---|
| `tokenSecretRef` | `null` | Company secret binding for a read-only GitHub token. Only the ref is stored; the token value is never logged. |
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
| `labelIdByName` | `{}` | Paperclip label IDs keyed by name. Only names present here can be synced (there is no labels read API). Include the `gh:awaiting/us` and `gh:awaiting/maintainer` IDs for the awaiting facet and the GitHub-tab metric counts to stay in sync. |
| `dryRun` | `false` | Log intended creates/wakes/updates without making them. |

## Capabilities

`companies.read`, `issues.read`, `issue.subtree.read`, `issues.create`, `issues.update`, `issues.wakeup`, `jobs.schedule`, `http.outbound`, `secrets.read-ref`, `plugin.state.read`, `plugin.state.write`.

## Dry run

`bin/github-upstream-dryrun.mjs` runs both jobs end to end against the real GitHub API with a file-backed state store and a stub Paperclip client. Nothing is created, woken or updated; the token comes from `GITHUB_TOKEN` or `--token-file`, never from config. Run it twice with the same `--state` file: the second run is mostly `304`s and reports the same intentions.

```sh
GITHUB_TOKEN=$(cat ~/.paperclip/github-upstream-token) \
paperclip-github-upstream-dryrun \
  --cards ./cards.json --config ./config.json --state ./dryrun-state.json
```

`cards.json` holds the tracker children reduced to `{id, parentId, originKind, originId, labels, labelIds, description, workProducts, assigneeAgentId, status, identifier}`. Dry-run intentions are printed as one JSON object per line.

## Development

```sh
npm ci
npm run check   # typecheck, tests, build
```

## License

MIT
