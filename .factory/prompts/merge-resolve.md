## Your job: resolve the merge of origin/main into the sandbox scratch worktree.

The scratch worktree `{scratch}` (local branch `scratch/{slug}`, never pushed) is `{sandbox_ref}` with `origin/main` being merged in, and the merge stopped on conflicts (`git -C {scratch} status`). The verify-antseed skill says: resolve conflicts minimally and record each resolution; `CHANGELOG.md` conflicts most often. Read `{verify_skill}` (step 1 of "Fix a bug red to green").

Work only in `{scratch}`. The fix worktree is read-only for you.
1. For each conflicted file, keep both sides' intent: main's product code wins for product behavior, the sandbox stack's additions (e2e/sandbox, skills, fault hooks) stay. Log one decision row per file.
2. `git -C {scratch} add -A && git -C {scratch} commit --no-edit`. Check `git -C {scratch} diff --name-only --diff-filter=U` is empty and there is no MERGE_HEAD.
3. Do not build or run anything else; the driver continues with `sandbox-scratch.sh {slug} setup --continue`.
4. Final message: one line per file and how you resolved it, then exactly `MERGE {slug} DONE`.
