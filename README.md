# paperclip-plugin-github-upstream

A [Paperclip](https://github.com/paperclipai/paperclip) plugin that notices upstream GitHub changes **deterministically, with zero LLM calls**, and only then creates or wakes a Paperclip card. It exists so follow-through work on upstream PRs/issues/discussions and release intake happens because the upstream changed, not because an agent went polling.

Two scheduled jobs do all the noticing:

| job | schedule | what it does |
|---|---|---|
| `release-scan` | `*/10 * * * *` | `GET /repos/{owner}/{repo}/releases/latest` with `If-None-Match` per configured repo. A `304` means do nothing; a new tag creates exactly one release-intake card (`originKind: plugin:togetherweown.github-upstream:release`, `originId: {owner}/{repo}@{tag}`). |
| `item-scan` | `*/15 * * * *` | ETag-conditional `GET`s for every tracked upstream issue/PR (`issues/{n}`, plus `pulls/{n}`, `pulls/{n}/reviews` and `commits/{head}/check-runs` while checks are pending) and one GraphQL query per tracked discussion. On a real change the owning follow-through card is woken with a deterministic one-line reason and idempotency key `upstream:{owner}/{repo}#{n}:{fingerprint}`. |

A real change is one of: `updated_at`, comment count, review count, check conclusion, head SHA, `state`/`merged`, draft flag. Labels (`gh:repo/*`, `gh:type/*`, `gh:state/*`, `gh:ci/*`) and a `<!-- github-upstream: … -->` description header are synced on change.

Our own upstream actions never wake our own card: on a changed fingerprint (never on a `304`) the plugin makes one extra `GET` for the latest actor — `issues/{n}/comments?since=<previous updatedAt>` when the comment count rose, plus `pulls/{n}/commits` when the head moved. If every observed actor is ours (`operatorLogin` plus `ourLogins`), the fingerprint is recorded as woken and the card stays asleep; the header and labels still sync. Anything unattributable still wakes — state changes, new reviews, removed comments, check drift, and discussions (a discussion number is not an issue number, so neither endpoint applies). A check re-run on the same head is not detected while checks are settled; that is acceptable.

## Card mapping

An upstream item maps to a card by `originId` (`{owner}/{repo}#{n}`), then by a GitHub URL work product, then by a GitHub URL in the description (the shape most existing follow-through cards are in). Cards found by URL get `originKind`/`originId` backfilled. New "ours" items with no card get a follow-through child of the tracker: a PR whose head matches `ourHeadPrefixes` (`TogetherWeOwn:*` by default) or whose author is `operatorLogin`. Issue search discovery (`discoveryQueries`) runs at most hourly and only creates cards for ours items.

## Rate limits

Every REST read is ETag-conditional: unchanged answers are `304`s that cost no quota. Check-run reads stop once checks settle. The plugin honors `X-RateLimit-Remaining`/`Retry-After`, backs off into plugin state, and records per-run `200`/`304` counts so the operator can see the sync costs nearly nothing. It never calls the CLIProxy management API (the HTTP layer only allows `api.github.com`).

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
| `labelIdByName` | `{}` | Paperclip label IDs keyed by name. Only names present here can be synced (there is no labels read API). |
| `dryRun` | `false` | Log intended creates/wakes/updates without making them. |
| `maxCreatesPerTick` | `2` | Per-scan-run cap on created cards. Overflow is deferred to the next tick, never dropped. |
| `maxWakesPerTick` | `5` | Per-scan-run cap on wakes (a create counts as a wake too). Overflow is deferred to the next tick, never dropped. |

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
