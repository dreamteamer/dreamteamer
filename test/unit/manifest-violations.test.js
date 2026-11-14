// The dependency rule a module's manifest is held to (cr-dt-007, D66): `dreamteamer` in a module's
// `dependencies` nests a second engine beside the one the workspace runs, so `dt check` names it.
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { manifestViolations } from "../../src/extensions.ts"

describe("manifestViolations", () => {
  test("dreamteamer under dependencies is a violation, named, with the fix", () => {
    assert.deepEqual(
      manifestViolations(
        { name: "@acme/acme", dependencies: { dreamteamer: "^0.48.0" }, dreamteamer: {} },
        "modules/acme/package.json"
      ),
      [
        {
          file: "modules/acme/package.json",
          message:
            "@acme/acme lists dreamteamer under dependencies — a second engine would be installed beside this one; move it to devDependencies or peerDependencies",
        },
      ]
    )
  })
  test("devDependencies and peerDependencies are fine; no dependencies at all is fine", () => {
    assert.deepEqual(
      manifestViolations(
        { name: "a", devDependencies: { dreamteamer: "0.48.0" }, peerDependencies: { dreamteamer: ">=0.48.0" } },
        "x"
      ),
      []
    )
    assert.deepEqual(manifestViolations({ name: "a" }, "x"), [])
    assert.deepEqual(manifestViolations({ name: "a", dependencies: { "js-yaml": "^4" } }, "x"), [])
  })
})
