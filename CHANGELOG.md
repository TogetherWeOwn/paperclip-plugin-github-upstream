# Changelog

## Unreleased

- GitHub App authentication: `appId`, `installationId` and `appPrivateKeySecretRef` replace the long-lived personal token. Short RS256 JWTs mint 1-hour installation tokens (in-memory only, refreshed 5 minutes before expiry, never logged or persisted). `tokenSecretRef` stays as the alternative; exactly one auth mode must be set.
- TWO-797 hardening: per-tick create/wake spend caps with next-tick deferral, one open intake card per repo (newer tags retitle and wake at most once), install baselines that never card the running version, closed/merged items skipped, case-insensitive owner/repo and login handling, untrusted-upstream-data sanitizing for card text, fail-closed scans (no anonymous reads), precise 403 rate-limit classification, and redirect refusal on every GitHub request.

## 0.1.0

- First release. ETag-conditional release scan (latest-release poll, one intake card per tag) and item scan (issue/PR/discussion tracking with deterministic wakes, label and description-header sync).
- Card mapping by `originId`, GitHub URL work product, and GitHub URL in the description, with `originKind`/`originId` backfill.
- Dry-run binary (`paperclip-github-upstream-dryrun`) that logs intended creates/wakes without making them.
