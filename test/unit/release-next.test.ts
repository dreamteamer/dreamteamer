// The pure half of `npm run release:next` (scripts/release-next.ts): the version it stamps, the
// package.json edit it must be able to undo byte for byte, and the leak rules it holds the tarball to.
import { test } from "node:test"
import assert from "node:assert/strict"
import { nextVersion, withVersion, hebrewAllowed, scan } from "../../scripts/release-next.ts"

const at = new Date("2026-11-19T14:30:05.123Z")
const file = (path, text) => ({ path, bytes: Buffer.from(text) })
const clean = { names: null, hebrewAllowed: new Set<string>() }

test("a stable version becomes a prerelease of its next patch, stamped with time and commit", () => {
  assert.equal(nextVersion("0.50.0", at, "7b95f2d"), "0.50.1-next.20261119143005.g7b95f2d")
})

test("a prerelease keeps its core version", () => {
  assert.equal(nextVersion("0.51.0-rc.1", at, "7b95f2d"), "0.51.0-next.20261119143005.g7b95f2d")
})

test("an all-digit sha with a leading zero still yields valid semver, thanks to the g prefix", () => {
  assert.match(nextVersion("1.2.3", at, "0123456"), /\.g0123456$/)
})

test("two builds of one day order by time", () => {
  const morning = nextVersion("1.0.0", new Date("2026-11-19T09:00:00Z"), "fffffff")
  const evening = nextVersion("1.0.0", new Date("2026-11-19T21:00:00Z"), "0000000")
  assert.ok(morning.split(".")[3] < evening.split(".")[3])
})

test("a version that is not semver, or a sha that is not hex, refuses", () => {
  assert.throws(() => nextVersion("latest", at, "7b95f2d"), /not semver/)
  assert.throws(() => nextVersion("1.0.0", at, "HEAD"), /not a commit sha/)
})

test("withVersion changes only the version value, so writing the original back undoes it exactly", () => {
  const original = '{\n\t"name": "dreamteamer",\n\t"version": "0.50.0",\n\t"type": "module"\n}\n'
  const stamped = withVersion(original, "0.50.1-next.1.gabc1234")
  assert.equal(stamped, original.replace("0.50.0", "0.50.1-next.1.gabc1234"))
  assert.equal(JSON.parse(stamped).version, "0.50.1-next.1.gabc1234")
  assert.throws(() => withVersion('{ "name": "x" }', "1.0.0"), /no "version"/)
})

test("the allow-list exempts Hebrew per file, and only for the hebrew rule", () => {
  const allowed = hebrewAllowed("# comment\n\na.js\thebrew\twhy\nb.js\tnames\twhy\n")
  assert.deepEqual([...allowed], ["a.js"])
})

test("the scan reports paths for names, credential shapes and Hebrew outside the allow-list", () => {
  const hits = scan(
    [
      file("dist/a.js", "made for ACME corp"),
      file("dist/b.js", "token npm_" + "a".repeat(36)),
      file("dist/c.js", "\u05E9\u05DC\u05D5\u05DD"),
      file("dist/d.js", "\u05E9\u05DC\u05D5\u05DD"),
      file("dist/e.js", "nothing to see"),
    ],
    { names: /acme/i, hebrewAllowed: new Set(["dist/d.js"]) }
  )
  assert.deepEqual(hits, { names: ["dist/a.js"], secrets: ["dist/b.js"], hebrew: ["dist/c.js"] })
})

test("binary files are skipped, as grep -I skips them", () => {
  const bytes = Buffer.concat([Buffer.from([0]), Buffer.from("npm_" + "a".repeat(36))])
  assert.deepEqual(scan([{ path: "x.png", bytes }], clean), { names: [], secrets: [], hebrew: [] })
})

test("without a names pattern, the name rule finds nothing", () => {
  assert.deepEqual(scan([file("a.js", "ACME")], clean).names, [])
})
