---
name: release-tag
description: Create and push a version tag for this repository, with mandatory user-approved release notes that GitHub Actions publishes as the GitHub Release body. Use when the user asks to release, publish a version, or create a release tag.
---

# Release Tag

Publish releases from `main` using an annotated `vMAJOR.MINOR.PATCH` tag. Release notes are mandatory. The workflow reads `.github/release-notes/v<version>.md` first, falling back to the tag annotation.

## Prepare

1. Check `git status --short`. If it has output, list the staged, unstaged, and untracked files, remind the user that there are uncommitted changes, and stop. Do not commit, discard, stash, or include them automatically.
2. Run `git fetch origin main --tags`, then inspect the current branch, upstream state, existing tags, and commits since the latest version tag. If fetching fails, report the failure and stop rather than treating cached refs as current.
3. Check `git rev-list --left-right --count origin/main...HEAD`:
   - If `HEAD` is ahead, list `git log --oneline origin/main..HEAD`, remind the user that commits have not been pushed, and stop.
   - If `HEAD` is behind or has diverged, report the state and stop.
   - If no upstream exists, remind the user to configure or push the upstream branch and stop.
4. Stop if the branch is not `main`, there are no release changes, or the target tag already exists locally or remotely.
5. Determine the SemVer version with the user. Accept `1.2.3` or `v1.2.3`, but normalize the tag to `v1.2.3`.
6. Require concrete release notes. If the user did not provide them, draft a concise Chinese list from the commits since the latest tag and ask the user to edit or approve it. Do not create or push a tag with generated notes that the user has not approved.

Use this release-note shape:

```markdown
## 更新内容

- 第一项用户可感知的变化
- 第二项用户可感知的变化
```

Describe outcomes rather than commit hashes. Omit empty sections.

## Verify

Run these commands and stop on failure:

```bash
npm run typecheck
npm test
npm run build
```

## Stage 1: Prepare Locally

Immediately before making changes, show the exact version and complete release notes and get explicit user confirmation.

After confirmation:

1. Set the package version without creating npm's automatic tag:

   ```bash
   npm version <version> --no-git-tag-version
   ```

2. Save the complete approved notes to `.github/release-notes/v<version>.md`.
3. Run the Verify commands after preparing these files. Check the final diff and stop on any failure before committing. Commit all release preparation files together (the version files and approved notes) with message `chore: release v<version>`; do not include unrelated files.
4. Create an annotated tag on that commit with `git tag -a v<version> -F .github/release-notes/v<version>.md`. A tag created before the commit would exclude the release preparation changes. Verify the tag resolves to `HEAD` and `git for-each-ref refs/tags/v<version> --format='%(contents)'` contains the complete approved notes; stop if empty or different.
5. Report the local commit and tag before starting any push. All local release work must be complete at this point. If the user requested local preparation only, stop here.

## Stage 2: Push

Run branch and tag pushes separately, only after Stage 1 succeeds:

```bash
git push origin main
git push origin v<version>
```

Stop immediately if either push fails. Preserve the prepared commit, notes file, and tag; do not delete, recreate, amend, or move them. Report which push failed and provide the remaining commands so the user can push manually. Never push the tag when the branch push failed.

For "continue release" after a failed push, inspect the existing release commit, notes, tag, worktree, and refreshed remote state. Resume only the pending pushes; do not repeat the version bump or create another release commit. The already-approved release commit awaiting push is expected in this recovery case, not a new unapproved change. Stop for unrelated changes or new commits. If both pushes were completed manually, verify the remote tag points to the prepared commit and report completion.

The `.github/workflows/release.yml` workflow creates the GitHub Release with the approved notes. Report a successful tag push separately from confirmed Release creation. If GitHub CLI is authenticated, optionally verify the workflow with `gh run list --workflow release.yml --limit 1`; do not retry or modify a failed release without inspecting the failure first.

Never overwrite, move, or delete an existing release tag unless the user explicitly requests that exact operation after the risk is explained.
