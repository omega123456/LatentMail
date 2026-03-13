#!/usr/bin/env bash
# Standalone script: run after clone or worktree creation to install deps and
# optionally sync context/agent files (CONTEXT.md, .claude, .opencode, opencode.json, .agent).
# Usage:
#   ./scripts/setup-worktree.sh [SOURCE_DIR]
#   SOURCE_DIR = directory to copy context files from (default: auto-detect another worktree)
set -e

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

copy_context_files() {
  local src="$1"
  if [ -z "$src" ] || [ ! -d "$src" ]; then
    return 0
  fi
  echo "Copying context/agent files from: $src"
  for name in CONTEXT.md .claude .opencode opencode.json .agent; do
    if [ -e "$src/$name" ]; then
      if [ -d "$src/$name" ]; then
        rm -rf "$REPO_ROOT/$name"
        cp -R "$src/$name" "$REPO_ROOT/$name"
        echo "  copied $name/"
      else
        cp "$src/$name" "$REPO_ROOT/$name"
        echo "  copied $name"
      fi
    fi
  done
}

# Resolve source directory: explicit arg, or another worktree
SOURCE_DIR="${1:-}"
if [ -z "$SOURCE_DIR" ]; then
  current_canon="$(cd "$REPO_ROOT" && pwd -P 2>/dev/null || cd "$REPO_ROOT" && pwd)"
  while IFS= read -r line; do
    wt_path="$(echo "$line" | awk '{print $1}')"
    [ -z "$wt_path" ] && continue
    wt_canon="$(cd "$wt_path" && pwd -P 2>/dev/null || cd "$wt_path" && pwd)"
    if [ "$wt_canon" != "$current_canon" ] && [ -d "$wt_path" ]; then
      SOURCE_DIR="$wt_path"
      break
    fi
  done < <(git worktree list 2>/dev/null || true)
fi

copy_context_files "$SOURCE_DIR"

echo "Running yarn install..."
yarn install
echo "Running electron rebuild for better-sqlite3..."
npx @electron/rebuild -f -w better-sqlite3
echo "Done."
