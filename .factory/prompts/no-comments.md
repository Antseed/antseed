## Your job: the no-comments pass on this change.

Read and follow `{skills}/no-comments/SKILL.md`. Comment Sicko's definition is `{pstack}/agents/comment-sicko.md`; spawn it with the Task tool, `subagent_type: "pstack:comment-sicko"` (if that type is unavailable, apply that file's rules yourself and say so). Subagents in this session are pinned to `{model}`. Scope: only the lines this change adds, `git -C {worktree} diff {base}..HEAD`; never comments that already existed on main.

This run is unattended and the caller has NOT pre-approved encodings (no-comments step 5): delete constraint comments that have no enforcement and report each one as open, with the cheapest encoding you would offer, in your final message.

1. Apply the accepted deletions and fixes. Keep exactly two commits on {base}: a change to the test file goes into commit 1, a change to source into commit 2 (`git -C {worktree} commit --fixup=<sha>` then `GIT_SEQUENCE_EDITOR=: git -C {worktree} rebase -i --autosquash {base}`). If nothing needs to change, change nothing.
2. If you changed anything, run the plan's Test command and the owning package's test and typecheck.
3. Check: two commits, clean `git status --porcelain`.
4. Final message: the no-comments report (deletions, restored, open constraints, encoding offers), then exactly `NOCOMMENTS {slug} DONE <number of comments deleted>`.
