import path from "node:path"

/** A relative path spelled with `/` on every OS — Windows' `path.relative` and `path.join` use `\`. */
export const toPosix = (p: string): string => p.split(path.sep).join("/")
