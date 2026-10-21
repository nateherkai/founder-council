# One-click updater source

This directory keeps the maintained PowerShell source used when packaging Roast Room one-click updater bundles.

The release bundle must place `RUN-ME.ps1` beside its matching patch file. The script intentionally refuses to run on a dirty working tree, verifies the expected remote and exact baseline commit, creates a local safety branch, applies the patch only after `git apply --check`, runs the verification suite, commits, and pushes without force-push.

Regression coverage lives in `scripts/updater-helper-smoke.ps1`. It protects two previously observed defects:

- resolving a short baseline such as `bc17b39` to its full commit before comparing it with `HEAD`;
- checking for an absent branch without calling `.Trim()` on empty/null native-command output.
