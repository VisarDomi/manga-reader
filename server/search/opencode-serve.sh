#!/bin/sh
# manga-search-opencode.service: the Home search's stripped OpenCode server on 127.0.0.1:7712.
# Creates its folders and the server password on first start (a restored PC needs no setup step);
# backups.mjs reads the same password from opencode.env.
set -eu
root="$HOME/.local/share/manga-reader/search"
umask 077
mkdir -p "$root/workspace" "$root/opencode/config" "$root/opencode/state" "$root/opencode/cache"
if [ ! -s "$root/opencode.env" ]; then
    password=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
    printf 'OPENCODE_SERVER_PASSWORD=%s\n' "$password" > "$root/opencode.env.tmp"
    mv "$root/opencode.env.tmp" "$root/opencode.env"
fi
set -a
. "$root/opencode.env"
set +a
# Its own configuration, state and cache; the data folder (and with it the OpenCode Go login) is the
# owner's own ~/.local/share/opencode.
export XDG_CONFIG_HOME="$root/opencode/config" XDG_STATE_HOME="$root/opencode/state" XDG_CACHE_HOME="$root/opencode/cache"
export OPENCODE_CONFIG="$(dirname "$(readlink -f "$0")")/opencode.json"
export OPENCODE_DISABLE_PROJECT_CONFIG=1 OPENCODE_DISABLE_CLAUDE_CODE=1 OPENCODE_DISABLE_FILEWATCHER=1 OPENCODE_DISABLE_FFF=1
cd "$root/workspace"
exec "${OPENCODE:-$HOME/.nvm/versions/node/v22.19.0/bin/opencode}" serve --hostname 127.0.0.1 --port 7712
