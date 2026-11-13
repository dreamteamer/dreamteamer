// held-out cr-dt-004-h1 — ids that are paths: a nested id and a namespaced collection as manifest keys
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { mkws, copyInto, coll, rec, NAME, MANIFEST, head, dt, git } from "./held-out-cr-dt-004-lib.js"

const COLLS = {
  people: coll("people", NAME),
  "ns/things": coll("ns/things", NAME),
  memos: coll("memos", { ...NAME, about: { type: ["people", "ns/things"], many: true } }),
}

test("h1: nested ids and a namespaced collection are single manifest keys, external in a reader, dropped when unreferenced", () => {
  const w = mkws({
    pkg: "w-ws",
    colls: COLLS,
    namespaces: ["ns"],
    files: {
      "data/memos/n1.memo.md": rec({ name: "N1", about: ["people/team/core/dana", "ns/things/box"] }),
      "data/ns/things/own.thing.md": rec({ name: "Own" }),
    },
    layers: {
      l: {
        pkg: "l-ws",
        files: {
          "data/people/team/core/dana.person.md": rec({ name: "Dana Core" }),
          "data/ns/things/box.thing.md": rec({ name: "Box" }),
        },
      },
    },
  })
  const c0 = dt(w.root, "check")
  assert.match(c0.stdout, /^⚠ people\/team\/core\/dana resolves only through layer l .* dt exports$/m, c0.stdout)
  assert.match(c0.stdout, /^⚠ ns\/things\/box resolves only through layer l .* dt exports$/m)
  assert.equal(dt(w.root, "exports").code, 0)
  const raw = fs.readFileSync(path.join(w.root, MANIFEST), "utf8")
  const refs = JSON.parse(raw).references
  assert.deepEqual(Object.keys(refs).sort(), ["ns/things", "people"])
  assert.deepEqual(refs.people, { "team/core/dana": { label: "Dana Core", from: "l-ws" } })
  assert.deepEqual(refs["ns/things"], { box: { label: "Box", from: "l-ws" } })
  assert.ok(raw.endsWith("\n") && raw.includes('\n\t"references"'), "tab indent, trailing newline")
  const r = mkws({ pkg: "r-ws", colls: COLLS, namespaces: ["ns"] })
  const wd = copyInto(r, w.root)
  const rc = dt(r.root, "check")
  assert.equal(rc.code, 0, rc.stdout)
  const info = rc.stdout.split("\n").filter(l => l.startsWith("ℹ layer w:"))
  assert.equal(info.length, 1, rc.stdout)
  assert.match(info[0], /people\/team\/core\/dana/)
  assert.match(info[0], /ns\/things\/box/)
  assert.doesNotMatch(rc.stdout, /dangling/)
  fs.renameSync(path.join(w.root, "git_modules", "l"), path.join(w.root, "l-away"))
  const g = dt(w.root, "get", "people/team/core/dana")
  assert.equal(g.code, 1)
  assert.match(g.stderr, /not held here/)
  assert.match(g.stderr, /Dana Core/)
  assert.match(g.stderr, /l-ws/)
  assert.deepEqual(JSON.parse(dt(w.root, "get", "people/team/core/dana", "--json").stdout).$external, {
    collection: "people",
    id: "team/core/dana",
    label: "Dana Core",
    from: "l-ws",
    manifest: MANIFEST,
  })
  assert.deepEqual(JSON.parse(dt(w.root, "get", "ns/things/box", "--json").stdout).$external, {
    collection: "ns/things",
    id: "box",
    label: "Box",
    from: "l-ws",
    manifest: MANIFEST,
  })
  fs.rmSync(path.join(wd, "data/memos/n1.memo.md"))
  git(wd, ["commit", "-qam", "drop n1"])
  const h = head(wd)
  const bytes = fs.readFileSync(path.join(wd, MANIFEST), "utf8")
  const st = dt(r.root, "check")
  assert.match(st.stdout, /people\/team\/core\/dana \(drop: no record references it\)/, st.stdout)
  assert.match(st.stdout, /ns\/things\/box \(drop: no record references it\)/)
  const dry = JSON.parse(dt(r.root, "exports", "--layer", "w", "--dry-run", "--json").stdout).manifests[0].changes
  assert.deepEqual(dry.map(c => `${c.ref}:${c.kind}`).sort(), ["ns/things/box:drop", "people/team/core/dana:drop"])
  assert.equal(head(wd), h)
  assert.equal(fs.readFileSync(path.join(wd, MANIFEST), "utf8"), bytes)
})
