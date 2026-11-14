/**
 * THE ONE PLACE A FLAG NAME IS VALIDATED — every record, system and field verb goes through
 * `collectionCommand`, so the check lives beside the parser they share rather than being
 * re-invented per verb.
 *
 * ⚠ IT EXISTS BECAUSE THE PARSER USED TO SWALLOW EVERYTHING. `dt add modules --name hr --bogusflag x`
 * succeeded silently, so a misspelled flag and a supported one were indistinguishable — and that is
 * what let `add modules --namespace hr` be accepted-and-ignored for a whole release with nobody
 * noticing. The worst instance was `--dryrun`, where the swallowed flag is the one standing between
 * a plan and a self-committed delete.
 *
 * TWO VOCABULARIES, and the split is what keeps the refusal honest. A verb's OPTIONS are closed and
 * enumerated here; an entity's own KEYS are open and cannot be — `dt list people --status todo` is a
 * shorthand filter on a declared field, `dt add people --name Ada` writes one, and a ui-view's
 * `display.list.options.*` is an open bag by design. So the allowlist is the table PLUS the target's declared
 * properties, and nothing is refused that either half can name.
 *
 * ⚠ A REFUSAL THAT REJECTS A VALID FLAG IS WORSE THAN THE SILENCE IT REPLACES, which is why a verb
 * with no table entry is left exactly as it was rather than being guessed at — and why the field
 * verbs' row is the whole `fieldFromFlags` vocabulary, read off nothing, so a flag added there has to be
 * added here too or its own test fails.
 *
 * A key is `<collection>:<verb>` where the system entity has its own interceptor, `<verb>` otherwise.
 */
export const FIELD_FLAGS = [
  "json",
  "module",
  "name",
  "type",
  "enum",
  "default-value",
  "default",
  "required",
  "description",
  "many",
  "unique",
  "soft",
  "body",
  "sensitive",
  "on-delete",
  "mirror-of",
]
