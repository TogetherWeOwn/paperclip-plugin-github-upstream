# Changelog

## Unreleased

- GitHub App authentication: `appId`, `installationId` and `appPrivateKeySecretRef` replace the long-lived personal token. Short RS256 JWTs mint 1-hour installation tokens (in-memory only, refreshed 5 minutes before expiry, never logged or persisted). `tokenSecretRef` stays as the alternative; exactly one auth mode must be set.
- TWO-797 hardening: per-tick create/wake spend caps with next-tick deferral, one open intake card per repo (newer tags retitle and wake at most once), install baselines that never card the running version, closed/merged items skipped, case-insensitive owner/repo and login handling, untrusted-upstream-data sanitizing for card text, fail-closed scans (no anonymous reads), precise 403 rate-limit classification, and redirect refusal on every GitHub request.
- GitHub tab: native `IssuesList` page slot scoped by `originKindPrefix` with a stable `viewStateKey`, plus a `MetricCard` row (open PRs, red CI, awaiting maintainer, awaiting us) fed by a new worker-registered `github-upstream-summary` data key.
- GitHub tab: native `IssuesList` page slot scoped by `originKindPrefix` with a stable `viewStateKey`, plus a `MetricCard` row (open PRs, red CI, awaiting maintainer, awaiting us) fed by a new worker-registered `github-upstream-summary` data key.
- Awaiting facet: `decideAwaiting` derives whose court the ball is in (us vs maintainer) from the item snapshot; `gh:awaiting/us` and `gh:awaiting/maintainer` labels sync onto tracking cards and flip on review-state changes.
- Stale `gh:*` label IDs are now swept by reverse lookup, so ID-only read paths cannot accumulate replaced facets.
- Upgrade from 0.1.0 no longer wakes every tracked card: the first scan backfills the new review-state field with one unconditioned reviews read per tracked PR and renormalizes the stored fingerprint, syncing the new awaiting labels silently.
- `decideAwaiting` returns null for non-ours open items whatever their review or CI state, matching the documented "non-ours items never get an awaiting label" contract.
- Tab metrics skip card-less records and prune records for items that are no longer tracked, so the counts agree with the visible list.
- Awaiting flips from config or label-map drift (no upstream change) sync labels/header quietly without waking.
- Manifest declares `ui.page.register` for the GitHub page slot (the host install rejected 2ab13e1 without it); a new test mirrors the host's manifest/capability consistency check so CI catches this class of error. Manifest wording now says release-intake cards are created for new tags after the install baseline.

## 0.1.0

- First release. ETag-conditional release scan (latest-release poll, one intake card per tag) and item scan (issue/PR/discussion tracking with deterministic wakes, label and description-header sync).
- Card mapping by `originId`, GitHub URL work product, and GitHub URL in the description, with `originKind`/`originId` backfill.
- Dry-run binary (`paperclip-github-upstream-dryrun`) that logs intended creates/wakes without making them.
