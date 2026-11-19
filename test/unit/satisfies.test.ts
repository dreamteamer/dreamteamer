// The built-in range check (src/lib/npm/satisfies.ts) behind module engine floors, peer ranges, init's
// engine pin and dreamteamer/testing's engine gate. The prerelease cases are the promise release:next
// rests on: a next engine passes the floors of the release it follows, and a floor can name a next.
import { test } from "node:test"
import assert from "node:assert/strict"
import { satisfies } from "../../src/lib/npm/satisfies.ts"

const NEXT = "0.50.1-next.20261119143005.g7b95f2d"

test("releases: >=, ^, ~, exact and *", () => {
  assert.equal(satisfies("0.50.0", ">=0.49.0"), true)
  assert.equal(satisfies("0.48.9", ">=0.49.0"), false)
  assert.equal(satisfies("0.49.3", "^0.49.0"), true)
  assert.equal(satisfies("0.50.0", "^0.49.0"), false, "^0.x pins the minor")
  assert.equal(satisfies("1.4.0", "^1.2.0"), true)
  assert.equal(satisfies("2.0.0", "^1.2.0"), false)
  assert.equal(satisfies("1.2.9", "~1.2.0"), true)
  assert.equal(satisfies("1.3.0", "~1.2.0"), false)
  assert.equal(satisfies("1.2.0", "1.2.0"), true)
  assert.equal(satisfies("1.2.1", "1.2.0"), false)
  assert.equal(satisfies("9.9.9", "*"), true)
})

test("what it does not understand is null, never a guess", () => {
  assert.equal(satisfies("latest", ">=1.0.0"), null)
  assert.equal(satisfies("1.0.0", ">=0.2.0 <0.3.0"), null)
  assert.equal(satisfies("1.0.0", ">=next"), null)
})

test("a next engine passes the floors of the release it follows", () => {
  assert.equal(satisfies(NEXT, ">=0.50.0"), true)
  assert.equal(satisfies(NEXT, "^0.50.0"), true)
  assert.equal(satisfies(NEXT, "~0.50.0"), true)
  assert.equal(satisfies(NEXT, ">=0.33.0"), true)
})

test("a prerelease sorts below its own release", () => {
  assert.equal(satisfies(NEXT, ">=0.50.1"), false)
  assert.equal(satisfies("0.50.1", `>=${NEXT}`), true)
})

test("a floor naming a next build admits it, later builds and later releases, and refuses older engines", () => {
  const floor = `>=${NEXT}`
  assert.equal(satisfies(NEXT, floor), true)
  assert.equal(satisfies("0.50.1-next.20261120090000.gabcdef0", floor), true, "a later stamp")
  assert.equal(satisfies("0.50.1-next.20261118090000.gabcdef0", floor), false, "an earlier stamp")
  assert.equal(satisfies("0.51.0", floor), true)
  assert.equal(satisfies("0.50.0", floor), false)
  assert.equal(satisfies("0.49.1", floor), false)
})

test("prerelease identifiers follow semver precedence", () => {
  assert.equal(satisfies("1.0.0-alpha.1", ">=1.0.0-alpha"), true, "a longer list sorts above its prefix")
  assert.equal(satisfies("1.0.0-alpha.10", ">=1.0.0-alpha.9"), true, "numeric identifiers compare as numbers")
  assert.equal(satisfies("1.0.0-alpha.9", ">=1.0.0-alpha.beta"), false, "numeric sorts below alphanumeric")
  assert.equal(satisfies("1.0.0-beta", ">=1.0.0-alpha"), true)
  assert.equal(satisfies("1.0.0+build.7", "1.0.0"), true, "build metadata is ignored")
})
