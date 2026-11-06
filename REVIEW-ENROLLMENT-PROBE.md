# Disposable review enrollment probe

This documentation-only change provides a fresh pull request head for observing
automatic review enrollment. It changes no runtime behavior, dependencies,
workflows, deployment configuration, or repository settings.

This probe is not intended to merge. After recording the actual review status and
check results, close the pull request without merging and remove its remote test
branch. A review status alone does not establish merge readiness or waive checks.
