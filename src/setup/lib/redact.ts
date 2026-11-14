/** A provider's FAILURE text, with anything that looks like a value gone: a `key=value` (a `<placeholder>`
 *  is not a value), a bearer token, an e-mail address, a home folder, a 32+-character token. Key names
 *  and shapes stay. Applied to what a unit throws, a failed apply's message and an action's reason —
 *  never to a check's fix or title, an action's title or a next-command line (D67). */
export function redact(text: unknown): string {
  return (
    String(text ?? "")
      // a key=value whose key is a secret word, alone or as the last part of a prefixed name (ACME_TOKEN=…);
      // a bare `key=` counts, a prefixed `primary_key=` does not; a <placeholder> is not a value
      .replace(
        /\b((?:[A-Za-z0-9]+[_-])*(?:token|secret|password|passwd|api[_-]?key|client[_-]?secret|credential))=(?!<)\S+/gi,
        "$1=[redacted]"
      )
      .replace(/(^|[^A-Za-z0-9_-])(key)=(?!<)\S+/gi, "$1$2=[redacted]")
      .replace(/\bBearer\s+\S+/g, "Bearer [redacted]")
      // an e-mail address — but not the `git@host` of an ssh remote
      .replace(/[^\s@"'<>():,`]+@[^\s@"'<>():,`/]+\.[A-Za-z]{2,}/g, m => (m.startsWith("git@") ? m : "<email>"))
      // a home folder where a path starts (a file URL, quotes, backticks, a comma list included) — not a
      // /home/ segment inside an http URL, not the shared folder
      .replace(/(?<=^|[\s"'=(:`,]|file:\/\/)\/(?:Users|home)\/(?!Shared\b)[^\s/"'`,]+/g, "~")
      .replace(/(?<=^|[\s"'=(:`,])[A-Za-z]:\\Users\\[^\s\\"'`,]+/g, "~")
      // a long token: 32+ characters of [A-Za-z0-9_-] — except an env key name (capitals in `_`-joined parts),
      // a dated id (a `--`) or a kebab id (three or more lower-case `-`-joined words, none over 16); a base32
      // seed, a one-case run or a prefixed token (xoxb-…) is a token
      .replace(/\b[A-Za-z0-9_-]{32,}\b/g, m =>
        /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(m) ||
        m.includes("--") ||
        (/^[a-z0-9]+(?:-[a-z0-9]+){2,}$/.test(m) && m.split("-").every(p => p.length <= 16))
          ? m
          : "[redacted]"
      )
  )
}
