#!/usr/bin/env bash
set -euo pipefail

BUMP="patch"
INSTALL=false
DRY_RUN=false

usage() {
  echo "Usage: $0 [--major|--minor|--patch] [--install] [--dry-run]"
  echo "  --major    Bump major version"
  echo "  --minor    Bump minor version"
  echo "  --patch    Bump patch version (default)"
  echo "  --install  Install the VSIX into VS Code after building"
  echo "  --dry-run  Validate and package the current version without bumping or installing"
  exit 1
}

for arg in "$@"; do
  case "$arg" in
    --major) BUMP="major" ;;
    --minor) BUMP="minor" ;;
    --patch) BUMP="patch" ;;
    --install) INSTALL=true ;;
    --dry-run) DRY_RUN=true ;;
    --help|-h) usage ;;
    *) echo "Unknown option: $arg"; usage ;;
  esac
done

cd "$(dirname "$0")/.."

npm run typecheck
npm test

if $DRY_RUN; then
  VERSION=$(node -p 'require("./package.json").version')
  NEW_VERSION="v$VERSION"
  INSTALL=false
  echo "Dry run: packaging current version $NEW_VERSION without installing"
else
  NEW_VERSION=$(npm version "$BUMP" --no-git-tag-version)
  echo "Bumped version to $NEW_VERSION"
fi

mkdir -p releases
VSIX="releases/supermarkdown-${NEW_VERSION#v}.vsix"
npm run package -- "$VSIX"

if $INSTALL; then
  echo "Installing $VSIX to all profiles..."
  code --install-extension "$VSIX" --force

  USER_DIR=""
  if [[ "$OSTYPE" == "darwin"* ]]; then
    USER_DIR="$HOME/Library/Application Support/Code/User"
  elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    USER_DIR="$HOME/.config/Code/User"
  fi

  STORAGE_JSON="$USER_DIR/globalStorage/storage.json"
  if [[ -n "$USER_DIR" && -f "$STORAGE_JSON" ]]; then
    node -e '
      const profiles = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).userDataProfiles ?? [];
      for (const profile of profiles) if (profile.name) console.log(profile.name);
    ' "$STORAGE_JSON" | while IFS= read -r profile; do
      echo "Installing to [$profile] profile..."
      code --profile "$profile" --install-extension "$VSIX" --force
    done
  fi

  echo "Installed successfully across all profiles. Reload VS Code to activate."
fi
