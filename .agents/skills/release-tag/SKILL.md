---
name: release-tag
description: Create and push a version tag for this repository, with mandatory user-approved release notes that GitHub Actions publishes as the GitHub Release body. Use when the user asks to release, publish a version, or create a release tag.
---

# Release Tag

Publish releases from `main` using an annotated `vMAJOR.MINOR.PATCH` tag. The tag annotation is the GitHub Release body, so release notes are mandatory.

## Prepare

1. Run `git fetch origin main --tags`, then inspect the current branch, worktree, upstream state, existing tags, and commits since the latest version tag.
2. Check `git status --short`. If it has output, list the staged, unstaged, and untracked files, remind the user that there are uncommitted changes, and stop. Do not commit, discard, stash, or include them automatically.
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

## Publish

Immediately before making changes, show the exact version and complete release notes and get explicit user confirmation.

After confirmation:

1. Set the package version without creating npm's automatic tag:

   ```bash
   npm version <version> --no-git-tag-version
   ```

2. Commit only the version files with message `chore: release v<version>` and push `main` to `origin`.
3. Write the approved notes to a temporary file, create an annotated tag with `git tag -a v<version> -F <notes-file>`, then delete the temporary file.
4. Push only that tag with `git push origin v<version>`. The `.github/workflows/release.yml` workflow creates the GitHub Release from the tag annotation.
5. Report the pushed tag. If GitHub CLI is authenticated, optionally verify the workflow with `gh run list --workflow release.yml --limit 1`; do not retry or modify a failed release without inspecting the failure first.

Never overwrite, move, or delete an existing release tag unless the user explicitly requests that exact operation after the risk is explained.
