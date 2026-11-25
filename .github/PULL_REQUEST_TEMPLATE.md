<!--
Guide: https://github.com/Antseed/antseed/blob/main/CONTRIBUTING.md
Title style: `fix(buyer-core): ...`, `feat(cli): ...`, `docs: ...`
From a fork: leave "Allow edits by maintainers" ticked, or the PR guard check fails.
Security problem or funds at risk? Do not open a PR. Report privately: https://github.com/Antseed/antseed/security/advisories/new
-->

## Problem

<!-- What is wrong or missing, and who it affects. -->

## Change

<!-- What you changed and why it fixes the problem. Say what you left out on purpose. -->

## Issue

<!--
Feature or behaviour change: write `Closes #<issue>` for its feature request. A feature nobody
  agreed to may be closed with a short no. If a maintainer named a scope there, build only that.
Bug fix, docs or tests: no issue needed. Write `Closes #<issue>` if there is a bug report, or "No issue".
Bug fix on a money path: the failing test is mandatory.
Calling a behaviour change a bug fix does not change what it is.
Maintainers: link the issue if there is one.
Feature: https://github.com/Antseed/antseed/blob/main/CONTRIBUTING.md#feature
Money paths: https://github.com/Antseed/antseed/blob/main/CONTRIBUTING.md#money-paths
-->

- Type: <!-- bug fix / feature or behaviour change / docs or tests -->
- Touches money paths: <!-- yes / no -->

Closes #

## Evidence

<!--
"Tests pass" alone is not evidence. https://github.com/Antseed/antseed/blob/main/CONTRIBUTING.md#evidence
Bug fix: name the test that fails without the fix. Paste its failing output (before) and passing output (after). The test name must appear in the output.
UI bug fix: the test and before and after screenshots. Other UI change: before and after screenshots.
Feature: the tests you added and what you ran. No test possible: say why, and what you checked by hand.
Hide wallet addresses, balances and keys. Put long output in a <details> block.
CI fails for a reason unrelated to this change: say so here. Do not fix it in this PR.
Delete lines that do not apply.
-->

- Test:
- Before:
- After:
- Not checked:

- [ ] One problem only. No unrelated changes.
- [ ] CHANGELOG.md updated, or this PR says it has no user-facing change.
- [ ] I have read the whole diff and I am responsible for it, including any AI-written code.
