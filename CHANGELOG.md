# Changelog

## Unreleased

- GitHub tab: native `IssuesList` page slot scoped by `originKindPrefix` with a stable `viewStateKey`, plus a `MetricCard` row (open PRs, red CI, awaiting maintainer, awaiting us) fed by a new worker-registered `github-upstream-summary` data key.
- Awaiting facet: `decideAwaiting` derives whose court the ball is in (us vs maintainer) from the item snapshot; `gh:awaiting/us` and `gh:awaiting/maintainer` labels sync onto tracking cards and flip on review-state changes.
- Stale `gh:*` label IDs are now swept by reverse lookup, so ID-only read paths cannot accumulate replaced facets.

## 0.1.0

- First release. ETag-conditional release scan (latest-release poll, one intake card per tag) and item scan (issue/PR/discussion tracking with deterministic wakes, label and description-header sync).
- Card mapping by `originId`, GitHub URL work product, and GitHub URL in the description, with `originKind`/`originId` backfill.
- Dry-run binary (`paperclip-github-upstream-dryrun`) that logs intended creates/wakes without making them.
