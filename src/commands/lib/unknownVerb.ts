import { emit } from "../../lib/emit.ts"
import { USAGE } from "../../usage.ts"

/**
 * Verbs an extension answers, and the package it ships in — typed without it, the verb prints the
 * install line. The container verbs belong to the global `dt-docker` bin, which needs no workspace.
 */
const VERB_PACKAGES: Record<string, string> = {
  prove: "@dreamteamer/proofs",
  land: "@dreamteamer/worktrees",
  worktree: "@dreamteamer/worktrees",
  serve: "@dreamteamer/web",
  web: "@dreamteamer/web",
  notebooklm: "@dreamteamer/notebooklm",
}
const DOCKER_VERBS = new Set(["start", "stop", "open", "export", "import"])

/**
 * A verb neither core nor any loaded extension answers.
 *
 * ⚠ NAMED, not just unknown. Every doc, skill and downstream script spelled the retired verbs
 * `dt schema <op>` for seven releases, so the failure has to carry the translation — an "unknown
 * verb" alone sends the reader to `help` to guess which of thirty verbs replaced the one they typed.
 * No alias layer and no deprecation window: 0.12.0's policy, and the reason it is the right one is
 * that `dt contacts list` failing loudly is what taught the verb-first grammar in one command.
 *
 * ⚠ ONE EXIT CODE FOR ALL OF THEM: 2, the usage code. "You typed a verb that is gone" is one answer,
 * so a script (and an operator) asks it once rather than learning which retirement exits 1 and which
 * exits 2.
 */
export function unknownVerb(cmd: string): number {
  if (cmd === "schema") {
    console.error(
      '✖ unknown verb "schema" — schema verbs are gone since 0.19.0. System entities take the RECORD verbs now:'
    )
    console.error(
      "    dt add collections --name <c> [--module <m>] · dt rm collections/<c> · dt rename collections/<old> <new>"
    )
    console.error("    dt set collections/<c> module=<m> | <scalar>=<v>   · dt get collections/<c> [--module <m>]")
    console.error(
      "    dt add-field <c> … · dt set-field <c> … · dt rm-field <c> … · dt rename-field <c> --name <f> --to <g>"
    )
    console.error("    dt add|set|rm|rename modules/<id> …               · dt add|set|rm|rename ui-views/<id> …")
    console.error(
      "  the full mapping table is in UPDATING.md (0.18.0 → 0.19.0), and `dt help` has the current spellings."
    )
    return 2
  }
  if (cmd === "ensure") {
    console.error(
      '✖ unknown verb "ensure" — gone since 0.22.0 (decision 309: install is the one verb that makes a thing present and ready):'
    )
    console.error("    dt install                 this checkout — engine, .env, local assets, compile, postinstall")
    console.error("    dt install repos/<id>      materialize one attached repo · dt install repos --all")
    return 2
  }
  // The change verbs spell one way. `add · set · rm · rename` are the record verbs, so
  // `update-field`/`remove-field` were a second spelling for one action inside one
  // grammar — the field verbs now say `add-field · set-field · rm-field · rename-field`.
  if (cmd === "update-field" || cmd === "remove-field") {
    const to = cmd === "update-field" ? "set-field" : "rm-field"
    console.error(
      `✖ unknown verb "${cmd}" — gone since 0.22.0 (decision 309: a field verb spells its action the way the record verbs do):`
    )
    console.error(`    dt ${to} <collection> --name <field> …`)
    console.error("    the field verbs are: dt add-field · dt set-field · dt rm-field · dt rename-field")
    return 2
  }
  // `dt commands <ref>` and `dt list commands` were one word for two things — the read
  // verb and the system entity. `next` also says what it answers.
  if (cmd === "commands") {
    console.error(
      '✖ unknown verb "commands" — gone since 0.22.0 (decision 309: it collided with the `commands` ENTITY, which `dt list commands` reads):'
    )
    console.error("    dt next <collection>[/<id>]   which bound commands apply to this record, and in which state")
    console.error("    dt list commands              the command entities this workspace ships")
    return 2
  }
  if (VERB_PACKAGES[cmd]) {
    console.error(
      `✖ \`dt ${cmd}\` comes from an extension this workspace does not have — install it:\n    dt install ${VERB_PACKAGES[cmd]}`
    )
    return 2
  }
  if (DOCKER_VERBS.has(cmd)) {
    console.error(
      `✖ \`dt ${cmd}\` is not a workspace verb — containers are managed by dt-docker:\n    npm i -g @dreamteamer/docker-workspaces\n    dt-docker ${cmd} container <name>`
    )
    return 2
  }
  console.error(`✖ unknown verb "${cmd}" — the verb comes first: dt <verb> [<target>]`)
  emit(USAGE, 2)
  return 1
}
