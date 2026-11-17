#!/usr/bin/env bash
# Merges upstream/main into the current branch. Never pushes.
#
# A conflict in pnpm-lock.yaml alone is resolved by taking upstream's lock file and
# regenerating it from the merged package.json. Any other conflict stops the script
# with the file list and leaves the merge in place for a person to finish.
#
# After the merge, scripts/check-private-names.mjs confirms the files listed in
# scripts/upstream-edits.txt carry no names that belong only to the private fork.
#
# Env: UPSTREAM_URL (default https://github.com/block/buzz-app.git).
set -euo pipefail

UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/block/buzz-app.git}"

die() { echo "sync-upstream: $*" >&2; exit 1; }

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not inside a git repository"
cd "$(git rev-parse --show-toplevel)"

branch="$(git symbolic-ref --quiet --short HEAD || true)"
[ -n "$branch" ] || die "HEAD is detached. Check out a branch first."

# Untracked files are ignored on purpose: git refuses a merge that would overwrite one.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  die "uncommitted changes in the working tree. Commit or stash them first."
fi

if git remote get-url upstream >/dev/null 2>&1; then
  current_url="$(git remote get-url upstream)"
  if [ "$current_url" != "$UPSTREAM_URL" ]; then
    echo "sync-upstream: remote 'upstream' already exists with a different URL." >&2
    echo "  existing: $current_url" >&2
    echo "  expected: $UPSTREAM_URL" >&2
    exit 1
  fi
else
  git remote add upstream "$UPSTREAM_URL"
  echo "Added remote 'upstream' ($UPSTREAM_URL)."
fi

git fetch upstream
git rev-parse --verify --quiet upstream/main >/dev/null || die "upstream/main not found after fetch"

if git merge-base --is-ancestor upstream/main HEAD; then
  echo "$branch is already up to date with upstream/main."
  exit 0
fi

count="$(git rev-list --count HEAD..upstream/main)"

if ! merge_out="$(git merge --no-edit upstream/main 2>&1)"; then
  echo "$merge_out" >&2
  [ -f "$(git rev-parse --git-path MERGE_HEAD)" ] || die "merge failed before it started."
  conflicts="$(git diff --name-only --diff-filter=U)"
  if [ -z "$conflicts" ]; then
    echo "sync-upstream: merge stopped with no conflicting files (for example a failing hook)." >&2
    echo "The merge is left in place. Fix the cause, then run 'git commit', or run 'git merge --abort' to undo." >&2
    exit 1
  fi
  non_lock="$(printf '%s\n' "$conflicts" | grep -vx 'pnpm-lock.yaml' || true)"
  if [ -n "$non_lock" ]; then
    echo "sync-upstream: merge stopped on conflicts outside pnpm-lock.yaml. Conflicting files:" >&2
    printf '%s\n' "$conflicts" | sed 's/^/  /' >&2
    echo "Resolve them, then run 'git commit', or run 'git merge --abort' to undo." >&2
    exit 1
  fi
  echo "Regenerating pnpm-lock.yaml after a lock file conflict."
  git checkout --theirs -- pnpm-lock.yaml
  bin/pnpm install --lockfile-only
  git add pnpm-lock.yaml
  git commit --no-edit
else
  echo "$merge_out"
fi

echo "Merged $count commit(s) from upstream/main into $branch. Nothing was pushed."
node_bin=node
[ -x bin/node ] && node_bin=bin/node
"$node_bin" scripts/check-private-names.mjs
echo "To publish: git push origin $branch"
