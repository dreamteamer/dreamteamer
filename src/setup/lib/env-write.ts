import path from "node:path"

export class EnvRefusal extends Error {
  /** why it was refused: `key` · `value` · `twice` · `symlink` · `not-file` · `changed` */
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export const tempPrefix = (target: string): string => `${path.basename(target)}.setup-`
