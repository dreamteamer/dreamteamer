/** The idempotent answer, in `rename-collection`'s words — a command that asks for what is already
 *  there succeeded, and the operator needs to know which field it was talking about. */
export function alreadyThat(subject: string): number {
  console.log(`✔ ${subject} — already exactly that, nothing to do`)
  return 0
}
