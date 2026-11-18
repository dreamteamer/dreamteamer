// The `setup` contribution (extension API 1, version 1): a list of units a module declares so that
// `dt install`, `dt setup` and `dt status` can drive its setup without knowing its name. Pure: the
// validator sees the contribution object and the package's declared env/vars, and returns the units
// with their defaults filled or the refusals, each naming the unit and the field.
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { validateSetup, SETUP_VERSION, INPUT_KINDS, validateEnvAction, isEnvAction } from "../../src/setup-contract.ts"

const fn = () => ({})
const unit = (extra = {}) => ({ id: "probe", version: 1, inputs: [], inspect: fn, plan: fn, apply: fn, ...extra })

describe("validateSetup — a valid list", () => {
  test("one unit, defaults filled, the module stamped", () => {
    const { units, errors } = validateSetup(
      "@probe/setup",
      [unit({ inputs: [{ id: "home", kind: "path", env: "PROBE_HOME" }] })],
      { env: [], vars: ["PROBE_HOME"] }
    )
    assert.deepEqual(errors, [])
    assert.equal(units.length, 1)
    assert.equal(units[0].module, "@probe/setup")
    assert.deepEqual(units[0].inputs, [
      {
        id: "home",
        kind: "path",
        env: "PROBE_HOME",
        required: false,
        title: "home",
        default: undefined,
        prompt: undefined,
        rows: undefined,
      },
    ])
  })
  test("the version and the kinds are exported for the help text", () => {
    assert.equal(SETUP_VERSION, 1)
    assert.deepEqual(INPUT_KINDS, ["string", "path", "rows", "secret-path"])
  })
  test("no contribution at all is no units and no errors", () => {
    assert.deepEqual(validateSetup("x", undefined, {}), { units: [], errors: [] })
  })
})

describe("validateSetup — refusals name the unit and the field", () => {
  test("not a list", () => {
    assert.deepEqual(validateSetup("x", { id: "a" }, {}).errors, [
      "extension x: setup must be a list of units (got an object)",
    ])
  })
  test("a version this engine does not understand", () => {
    assert.deepEqual(validateSetup("x", [unit({ version: 2 })], {}).errors, [
      "unit probe declares setup version 2; this engine understands 1 — update the engine or the module",
    ])
  })
  test("a bad unit id", () => {
    assert.deepEqual(validateSetup("x", [unit({ id: "Probe Unit" })], {}).errors, [
      'extension x: a setup unit id is a lowercase slug (got "Probe Unit")',
    ])
  })
  test("two units with one id in one package", () => {
    assert.deepEqual(validateSetup("x", [unit(), unit()], {}).errors, [
      'extension x: setup unit "probe" is declared twice',
    ])
  })
  test("a missing function", () => {
    assert.deepEqual(validateSetup("x", [unit({ plan: undefined })], {}).errors, [
      "unit probe: plan must be a function",
    ])
  })
  test("an input kind outside the vocabulary", () => {
    assert.deepEqual(validateSetup("x", [unit({ inputs: [{ id: "a", kind: "number" }] })], {}).errors, [
      'unit probe: input a has kind "number" — one of string, path, rows, secret-path',
    ])
  })
  test("an input env the package does not declare", () => {
    assert.deepEqual(
      validateSetup("x", [unit({ inputs: [{ id: "a", kind: "string", env: "PROBE_TOKEN" }] })], {
        env: ["OTHER"],
        vars: [],
      }).errors,
      ["unit probe: input a names env PROBE_TOKEN, which the package does not declare in dreamteamer.env or vars"]
    )
  })
  test("a rows input without columns", () => {
    assert.deepEqual(validateSetup("x", [unit({ inputs: [{ id: "r", kind: "rows" }] })], {}).errors, [
      "unit probe: input r is rows and must declare rows.columns",
    ])
  })
  test("a bad input id", () => {
    assert.deepEqual(validateSetup("x", [unit({ inputs: [{ id: "My-Input", kind: "string" }] })], {}).errors, [
      'unit probe: an input id is a lowercase identifier (got "My-Input")',
    ])
  })
})

// ---- 0.48.0: apply optional, inspect synchronous, the `env` action (cr-dt-007, D61) ----------------

describe("validateSetup — apply is optional, inspect is synchronous", () => {
  test("a unit with no apply validates; its apply is undefined on the loaded unit", () => {
    const { units, errors } = validateSetup("x", [unit({ apply: undefined })], {})
    assert.deepEqual(errors, [])
    assert.equal(units[0].apply, undefined)
  })
  test("an apply that is present but not a function is refused", () => {
    assert.deepEqual(validateSetup("x", [unit({ apply: 1 })], {}).errors, [
      "unit probe: apply must be a function when present",
    ])
  })
  test("an async inspect is refused by name — dt status reads it without awaiting", () => {
    assert.deepEqual(validateSetup("x", [unit({ inspect: async () => ({ checks: [] }) })], {}).errors, [
      "unit probe: inspect must be synchronous — dt status reads it without awaiting",
    ])
  })
})

describe("validateEnvAction — the shape of an env action, judged when a plan is read", () => {
  const declared = new Set(["ACME_TOKEN", "ACME_HOME"])
  test("a plain action is not an env action", () => {
    assert.equal(isEnvAction({ id: "fetch" }), false)
    assert.equal(isEnvAction({ id: "set", env: { ACME_TOKEN: "x" } }), true)
  })
  test("string values for declared keys are ok", () => {
    assert.deepEqual(validateEnvAction({ id: "set", env: { ACME_TOKEN: "abc", ACME_HOME: "/x" } }, declared), {
      ok: true,
    })
  })
  test("an undefined or null value means the action needs input", () => {
    assert.deepEqual(validateEnvAction({ id: "set", env: { ACME_TOKEN: undefined } }, declared), {
      ok: false,
      state: "needs-input",
      reason: "ACME_TOKEN has no value yet",
    })
    assert.deepEqual(validateEnvAction({ id: "set", env: { ACME_TOKEN: null } }, declared), {
      ok: false,
      state: "needs-input",
      reason: "ACME_TOKEN has no value yet",
    })
  })
  test("a non-string value is refused naming the key", () => {
    assert.deepEqual(validateEnvAction({ id: "set", env: { ACME_TOKEN: 42 } }, declared), {
      ok: false,
      state: "blocked",
      reason: "ACME_TOKEN: a value that is not a string",
    })
  })
  test("an undeclared key is refused naming the key", () => {
    assert.deepEqual(validateEnvAction({ id: "set", env: { OTHER: "x" } }, declared), {
      ok: false,
      state: "blocked",
      reason: "OTHER is not declared by the package (dreamteamer.env or vars)",
    })
  })
  test("a key that is not an environment key is refused", () => {
    assert.deepEqual(validateEnvAction({ id: "set", env: { "acme-token": "x" } }, declared), {
      ok: false,
      state: "blocked",
      reason: "acme-token is not an environment key",
    })
  })
  test("env that is not an object is refused", () => {
    assert.deepEqual(validateEnvAction({ id: "set", env: "ACME_TOKEN=x" }, declared), {
      ok: false,
      state: "blocked",
      reason: "env must be an object of KEY → value",
    })
  })
})
