// A CONSUMER of the published declarations, type-checked under `strict` by
// test/integration/public-api.test.js against the GENERATED dist/*.d.ts. It is the contract's test now
// that the declarations come from the source: every line below is something the editor, the mobile app
// or an extension relies on, and every `@ts-expect-error` is a promise that a signature is NOT `any` —
// if one loosens, the expected error disappears and the unused directive fails the compile.
import * as dt from "dreamteamer"
import * as records from "dreamteamer/records"
import * as testing from "dreamteamer/testing"
import type {
  Descriptor,
  Fields,
  Workspace,
  LoadedExtension,
  Presentation,
  Storage,
  Manifest,
  Contribution,
  Activate,
} from "dreamteamer"

type IsAny<T> = 0 extends 1 & T ? true : false
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
/** compiles only when T is `true` */
const is = <T extends true>(..._proof: T[]): void => {}
/** compiles only when the value is assignable to T — the assertion a typed `const` used to make */
const accept = <T>(_value: T): void => {}

// ---- PRECISION RATCHET: no public function — and no Store method — takes or returns `any`. It held an
// allow-list (the 25 schema ops, `loadYaml`, `distinctValues`) and a hand-picked subset of Store methods
// until the engine was typed under `noImplicitAny`; both are gone, so a signature that loosens now fails
// here whichever export it is. Never re-introduce a list without a reason written beside it.
type Fn = (...a: never[]) => unknown
type LooseFn<F> = F extends Fn
  ? IsAny<ReturnType<F>> extends true
    ? true
    : true extends { [K in keyof Parameters<F>]: IsAny<Parameters<F>[K]> }[number]
      ? true
      : false
  : false
type Loose<M> = { [K in keyof M]: LooseFn<M[K]> extends true ? K : never }[keyof M]
is<Equals<Loose<typeof dt>, never>>()
is<Equals<Loose<typeof records>, never>>()
is<Equals<Loose<typeof testing>, never>>()
is<Equals<Loose<dt.Store>, never>>()

// ---- the values and their kinds (F8: a declared array that is a Set at run time) ------------------
is<Equals<typeof dt.apiVersion, 1>>()
is<Equals<typeof dt.EXTENSION_API, 1>>()
is<Equals<typeof dt.CHECK_WARNINGS, true>>()
is<Equals<typeof dt.RUNTIME_DIR, ".dreamteamer">>()
const ops: ReadonlySet<string> = dt.KNOWN_OPERATORS
// @ts-expect-error — a Set, not an array
dt.KNOWN_OPERATORS.includes("_eq")
const kinds: readonly string[] = dt.KINDS
// @ts-expect-error — readonly
dt.KINDS.push("x")

// ---- the workspace and the Store ---------------------------------------------------------------
async function surface() {
  const ws = await dt.openWorkspace("/w")
  is<Equals<typeof ws, Workspace & { extensions: LoadedExtension[] }>>()
  const ext: LoadedExtension = ws.extensions[0]
  accept<string>(ext.name)
  const store = new dt.Store(ws)
  // @ts-expect-error — a workspace handle, not a path
  new dt.Store("/w")
  const d: Descriptor = store.descriptor("notes")
  is<Equals<ReturnType<typeof store.read>, { fields: Fields; file: string }>>()
  // @ts-expect-error — ids are strings
  store.read("notes", 1)
  accept<Map<string, string>>(store.ids("notes"))
  const added = store.add("notes", { title: "x" }, { id: "x" })
  accept<string>(added.id)
  accept<{ file: string; repo: string | null }>(store.locate("notes", "a"))
  is<Equals<ReturnType<typeof store.external>, { label: string; from?: string; manifest: string } | null>>()
  for (const row of store.readAll("notes")) accept<Fields>(row.fields)
  accept<number>(store.rm("notes", "a").inboundIgnored)
  const plan = store.relocatePlan("notes")
  accept<"placement" | "shape">(plan.moves[0].why)

  const s: Storage = dt.storageOf(d)
  accept<string>(s.roots[0].path)
  accept<"md" | "yaml" | "json" | "binary">(s.format)
  accept<Manifest | null>(dt.readManifest("/w"))
  const p: Presentation = dt.presentation(store.descriptors)
  accept<string>(p.collections[0].title)
  const ref = dt.parseRef("notes/a", [])
  // @ts-expect-error — null when nothing parses
  accept(ref.collection)
  accept<0 | 1 | 2>(dt.check(ws))
  const commits = dt.commitPending(store, { dryRun: true })
  accept<string | null | undefined>(commits[0].sha) // null on a dry run
  accept<number>(await dt.installCommand(ws, ["install"]))
  accept<{ id: string }[]>(dt.sortRows([{ id: "a" }], "-id"))
  accept<(ref: string) => Fields | null>(dt.recordResolver(store))
  accept<dt.TemplatePart[]>(dt.parseTemplate("{{ name }}"))
  accept<string>(dt.engineBin)
}

// ---- the extension contract -------------------------------------------------------------------
const activate: Activate = api => {
  accept<1>(api.apiVersion)
  const c: Contribution = {
    commands: { hello: { usage: "dt hello", run: (ws, argv) => (argv.length ? 0 : 1) } },
    check: ({ ws }) => [{ message: `checked ${ws.root}` }],
    doctor: () => [{ label: "ok", state: "ok" }],
  }
  return c
}
// @ts-expect-error — a doctor row's state is one of three
const bad: Contribution = { doctor: () => [{ label: "x", state: "fine" }] }

// ---- `dreamteamer/testing` — a module's own suite on the real engine -----------------------------
const suite = (): void => {
  const ws: testing.Workspace = testing.createWorkspace({ engine: testing.ENGINE })
  const r: testing.Result = testing.install(ws, testing.pack("."), { timeoutMs: 1000, env: { K: "v" } })
  accept<number | null>(r.status)
  accept<string>(ws.dt(["status"], { input: "y\n" }).stdout)
  accept<testing.Result>(testing.run(ws, ["check"]))
  accept<boolean>(testing.engineMeets(">=0.48.0"))
  // @ts-expect-error — a run's args are a list, never one string
  testing.run(ws, "check")
  // @ts-expect-error — an env value is a string
  testing.run(ws, ["check"], { env: { K: 1 } })
}

export { surface, activate, bad, ops, kinds, suite }
