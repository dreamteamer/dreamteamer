// held-out cr-dt-004-h3 — reference unions; soft and mirror fields never listed
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkws, copyInto, coll, rec, NAME, manifest, dt, git } from "./held-out-cr-dt-004-lib.js"

test("h3: a union target is listed; soft and mirror values never are; a reader sees exactly the listed ones external", () => {
  const COLLS = {
    people: coll("people", {
      ...NAME,
      memos: { type: "memos", many: true, mirror_of: "about" },
      body: { type: "markdown", body: true },
    }),
    orgs: coll("orgs", NAME),
    memos: coll("memos", {
      ...NAME,
      about: { type: ["people", "orgs"], many: true },
      maybe: { type: "people", soft: true },
    }),
  }
  const w = mkws({
    colls: COLLS,
    files: {
      "data/people/own.person.md": rec({ name: "Own" }),
      "data/memos/n1.memo.md": rec({
        name: "N1",
        about: ["orgs/acme", "people/dana", "people/own"],
        maybe: "people/ghost",
      }),
      "data/memos/n2.memo.md": rec({ name: "N2", about: ["people/own"], maybe: "people/eli" }),
    },
    layers: {
      l: {
        pkg: "l-ws",
        files: {
          "data/people/dana.person.md": rec({ name: "Dana" }),
          "data/people/eli.person.md": rec({ name: "Eli" }),
          "data/orgs/acme.org.md": rec({ name: "Acme" }),
        },
      },
    },
  })
  assert.equal(dt(w.root, "relations", "rebuild", "people").code, 0)
  git(w.root, ["add", "-A"])
  git(w.root, ["commit", "-qm", "mirrors"])
  const c0 = dt(w.root, "check")
  const warned = [...c0.stdout.matchAll(/^⚠ (\S+) resolves only through layer/gm)].map(m => m[1]).sort()
  assert.deepEqual(warned, ["orgs/acme", "people/dana"], c0.stdout)
  assert.doesNotMatch(c0.stdout, /ghost|people\/eli/)
  assert.equal(dt(w.root, "exports").code, 0)
  assert.deepEqual(manifest(w.root), {
    orgs: { acme: { label: "Acme", from: "l-ws" } },
    people: { dana: { label: "Dana", from: "l-ws" } },
  })
  assert.equal(dt(w.root, "check", "--strict-export").code, 0)
  const r = mkws({ pkg: "r-ws", colls: COLLS })
  copyInto(r, w.root)
  const rc = dt(r.root, "check")
  assert.equal(rc.code, 0, rc.stdout)
  assert.match(rc.stdout, /^ℹ layer w: .*\(orgs\/acme, people\/dana\)$/m)
  assert.doesNotMatch(rc.stdout, /ghost|people\/eli|dangling|stale/)
})
