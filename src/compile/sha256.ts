import { createHash } from "node:crypto"

export const sha256 = (buf: Buffer | string): string => "sha256:" + createHash("sha256").update(buf).digest("hex")
