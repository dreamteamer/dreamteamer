#!/usr/bin/env bash
# The first sixty seconds of a new user's life, driven against the PACKED TARBALL — exactly what a
# stranger gets from npm, so a missing entry in files[] fails CI instead of failing a stranger.
# Run by ci.yml on Linux and on Windows (Git Bash); `npm test` covers behaviour, this covers
# DISTRIBUTION and the OS the suite does not run on.
#
#   bash scripts/first-run-smoke.sh        from the repo root
set -euo pipefail

PKG=$(npm pack --silent | tail -1)
PKG_PATH="$PWD/$PKG"
D=$(mktemp -d)
cd "$D"
git init -q
git config user.email ci@example.com
git config user.name CI
npm init -y >/dev/null
npm install --silent "$PKG_PATH"
npx dreamteamer init
npx dreamteamer compile
npx dreamteamer check
# ⚠ VERB-FIRST since 0.12.0. This step kept the collection-first spelling and CI was red on every
# push since 0.12.1 (2026-08-22) — six releases — because `release` is a separate workflow and it
# was green. Verified against the packed tarball, not assumed.
npx dreamteamer add notes --title "smoke"
npx dreamteamer list notes
npx dreamteamer check

# ---- the shapes that broke on Windows: a mixin, a skill with a nested file, an id with a `/` ----
# Compile used to key its runtime entries with `path.join`, so on Windows no mixin was found
# ("mixin … does not exist (have: none)"), the skills indexes rendered empty and no skill file was
# mirrored; source paths were stored with `\`, so a module listed none of its skills; record ids
# were read back as `2026-01-02\x`. Each check below failed on that build.
cat > modules/default/collections/memos.collection.yaml <<'YAML'
name: memos
description: A smoke collection — a mixin's fields under an id with a folder in it.
mixins: [entity]
ids:
  from: '{{ created | date }}/{{ name | slug }}'
  pattern: '^\d{4}-\d{2}-\d{2}/[a-z0-9-]+$'
fields: {}
YAML
mkdir -p modules/default/skills/smoke-skill/references
cat > modules/default/skills/smoke-skill/SKILL.md <<'MD'
---
name: smoke-skill
description: use when the first-run smoke needs a skill with a nested reference file
---
See references/more.md.
MD
echo "more" > modules/default/skills/smoke-skill/references/more.md

npx dreamteamer compile
grep -q '^- memos — ' CLAUDE.md || { echo "✖ memos missing from the CLAUDE.md collections index"; exit 1; }
grep -q 'smoke-skill' CLAUDE.md || { echo "✖ smoke-skill missing from the CLAUDE.md skills index"; exit 1; }
test -f .claude/skills/smoke-skill/references/more.md || { echo "✖ nested skill file not mirrored"; exit 1; }
npx dreamteamer status | grep -q 'is fresh' || { echo "✖ status does not call a just-compiled workspace fresh"; npx dreamteamer status; exit 1; }
npx dreamteamer add memos --name "First memo"
ID=$(npx dreamteamer list memos --json | node -e 'let s="";process.stdin.on("data",(c)=>s+=c).on("end",()=>{const r=JSON.parse(s);console.log((r.records??r)[0].id)})')
case "$ID" in
	*/first-memo) ;;
	*) echo "✖ memo id is \"$ID\", expected <date>/first-memo"; exit 1 ;;
esac
npx dreamteamer get "memos/$ID" >/dev/null
npx dreamteamer check
echo "✔ first-run smoke"
