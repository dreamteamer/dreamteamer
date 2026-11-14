import fs from "node:fs"

/**
 * Emit MACHINE-READABLE output synchronously. Use this for every `--json` payload.
 *
 * `console.log` to a pipe is asynchronous, and every CLI path ends in `process.exit()`, which
 * discards whatever is still buffered. A shell pipeline hides the bug completely — the reader
 * drains concurrently, so `dreamteamer list contacts --json | wc -c` reports all 32381 bytes — but
 * the way a script or a coding agent actually calls this is execFileSync/spawnSync, and there the
 * child exits with the pipe still full. Measured before this fix: the same command captured with
 * execFileSync returned exactly **8190 bytes** (one pipe buffer) of that 32381-byte document, i.e.
 * silently invalid JSON, with a zero exit status.
 *
 * Found while writing a setup script for a second operator — the first consumer to read `--json`
 * from a real program rather than a terminal.
 *
 * ⚠ 2026-07-30: a SINGLE `fs.writeSync` was NOT enough, and the previous version of this comment
 * claimed it was. Writing to a pipe performs one `write(2)`, which returns a SHORT COUNT once the
 * 64KB pipe buffer is full — it does not throw, it reports fewer bytes written and the caller
 * ignores the number. So the same truncation reappeared at a larger size: measured at exactly
 * **65126 bytes** of a ~100KB payload, again invalid JSON with a zero exit status. `meetings list
 * --json` (141767 bytes) was affected. Found in a sibling script that reproduced it twice, once
 * per fix.
 *
 * So: write in a LOOP until every byte lands, and retry EAGAIN — stdout can be a non-blocking pipe.
 *
 * ⚠ 2026-09-03: `USAGE` became the SECOND victim, and it is the one every agent reads. `dt help`
 * ended `console.log(USAGE); process.exit(0)`, which was fine while the text fit one pipe buffer —
 * and the system-verbs rewrite took it to 12,189 bytes. Measured with spawnSync: **8,113 bytes**
 * captured, i.e. help silently ends mid-sentence for every script, agent and test that reads it,
 * at exit 0. Hence the `fd` argument: `help` writes through here now, and so does the USAGE echoed
 * on an unknown verb (fd 2, same failure mode).
 */
export const emit = (s: string, fd: number = 1): void => {
  const buf = Buffer.from(s + "\n")
  let off = 0
  while (off < buf.length) {
    try {
      off += fs.writeSync(fd, buf, off, buf.length - off)
    } catch (e) {
      if (e.code === "EAGAIN") continue
      throw e
    }
  }
}
