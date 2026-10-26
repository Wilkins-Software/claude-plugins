#!/usr/bin/env bash
# Scaffold a new plugin from templates/plugin and register it in the marketplace.
# Usage: scripts/new-plugin.sh <name> "<description>"
set -euo pipefail

name="${1:?usage: scripts/new-plugin.sh <name> \"<description>\"}"
desc="${2:-}"
root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$root/plugins/$name"

if [[ ! "$name" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  echo "plugin name must be kebab-case" >&2; exit 1
fi
if [[ -e "$dest" ]]; then
  echo "plugins/$name already exists" >&2; exit 1
fi

cp -R "$root/templates/plugin" "$dest"
find "$dest" -type f -exec sed -i '' -e "s/PLUGIN_NAME/$name/g" -e "s|PLUGIN_DESCRIPTION|$desc|g" {} +

# Register in marketplace.json
manifest="$root/.claude-plugin/marketplace.json"
tmp="$(mktemp)"
jq --arg name "$name" --arg desc "$desc" \
  '.plugins += [{name: $name, source: ("./plugins/" + $name), description: $desc, version: "0.1.0"}] | .plugins |= sort_by(.name)' \
  "$manifest" > "$tmp" && mv "$tmp" "$manifest"

echo "Created plugins/$name and registered it in marketplace.json."
echo "Delete the example skill/command/agent/hooks you don't need, then run: claude plugin validate ."
