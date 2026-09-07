#!/bin/sh
# dt-hook.sh — run the engine from a harness hook, where there is no PATH to speak of.
#
# ⚠ THIS FILE EXISTS BECAUSE OF A MEASUREMENT, not a worry. A harness hook is `sh -c`, and `sh`
# reads NO startup file — not .zshenv, not .bash_profile, not .bashrc. On the machine where the
# first live worktree spawn was watched:
#
#     env -i zsh -c 'command -v node'   ->  ~/.nvm/versions/node/<v>/bin/node
#     env -i sh  -c 'command -v node'   ->  NOT FOUND
#
# So a hook line beginning with a bare `npm`, `npx` or `node` fails, and fails SILENTLY: a fresh
# worktree has no node_modules either, so there is nothing to fall back to, and a hook's stderr goes
# to a log the session never reads. A shell-profile fix cannot reach this (`bash -c` and `sh -c`
# were both measured failing after one was applied) and would not travel with the workspace anyway.
# Hence an absolute resolution, here, in the one language a hook is guaranteed to have.
#
#   sh /path/to/dt-hook.sh <verb> [args...]
#
# Resolution order: $DREAMTEAMER_NODE · node on PATH · the highest ~/.nvm install · /opt/homebrew ·
# /usr/local. The last two are where the two common non-nvm installers put it.
set -eu

node=""
if [ -n "${DREAMTEAMER_NODE:-}" ] && [ -x "${DREAMTEAMER_NODE}" ]; then
	node="${DREAMTEAMER_NODE}"
elif command -v node >/dev/null 2>&1; then
	node="$(command -v node)"
else
	# `sort -V`, never a plain sort: v9.9.9 sorts AFTER v10.10.0 lexicographically, which would hand
	# every hook the oldest install on the disk. A glob that matches nothing expands to itself, so
	# the whole pipeline is allowed to come back empty rather than being trusted.
	nvm=""
	if [ -n "${HOME:-}" ]; then
		nvm="$(ls -d "${HOME}"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)" || nvm=""
	fi
	for candidate in "${nvm}" /opt/homebrew/bin/node /usr/local/bin/node; do
		if [ -n "${candidate}" ] && [ -x "${candidate}" ]; then
			node="${candidate}"
			break
		fi
	done
fi

# ⚠ STDOUT, NOT STDERR, and that is the whole point of failing loudly here: a hook's stdout is added
# to the session's context, so this line is read by the agent that is about to work in a checkout
# nothing has made ready. Its stderr is not.
if [ -z "${node}" ]; then
	echo "✖ dreamteamer hook: node not found — set DREAMTEAMER_NODE=/path/to/node in the harness environment, or install node under ~/.nvm, /opt/homebrew or /usr/local"
	exit 1
fi

exec "${node}" "$(dirname "$0")/dreamteamer.js" "$@"
