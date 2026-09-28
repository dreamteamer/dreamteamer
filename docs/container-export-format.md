# The container export format (version 1)

What `dt export container <name> --out <file>` writes and `dt import container <name> <file>` reads.
Any other implementation that writes or reads a machine's workspaces (a hosted service, a backup
store) implements exactly this. The code is `src/container-archive.js`.

## Layers

```
file      = sealed(gzip(tar))          the default
file      = gzip(tar)                  --no-encrypt: a plain .tar.gz, told apart by its first bytes 1f 8b
```

## The tar

- Entries are rooted at the **workspaces root** (`/workspaces` in the container): `acme/`,
  `acme/README.md`. Every entry lies inside a top-level folder, one per workspace, whose name matches
  `^[a-z0-9][a-z0-9_.-]*$`. A top-level entry that is not a folder is not allowed.
- Only regular files (`0`), directories (`5`) and symbolic links (`2`). No hard links, devices or fifos.
- A symlink's target, resolved from the link's own folder, stays inside **its own workspace** folder.
- No absolute names, no `.` or `..` segments, no empty segments.
- Headers are ustar; a name or link target longer than 100 bytes is carried in a PAX `x` record
  (`path`, `linkpath`) before its header. Readers also accept GNU `L`/`K` long names.
- Owner and group are 0, mode is the permission bits only (no setuid, setgid or sticky). The importer
  sets the owner itself (`chown -R node:node` on each imported workspace).
- Never included: the home (`/home/node`, where logins live), any folder named `node_modules` or
  `.files`, at any depth.
- Secrets, unless the owner exports with `--with-secrets`: at any depth, no file named `.env`, no
  `.env.<anything>` except `.env.example`, `.env.sample` and `.env.template`, no `.envrc`, `.npmrc`,
  `.netrc`, `.git-credentials` or `.pypirc`, and no `config.json` inside a `.docker` folder. Every
  `…/.git/config` is rewritten: every `[credential]` and `[credential "…"]` (or
  `[credential.…]`) section removed, header to next header — an inline `!` helper can hold a
  password; every `extraheader` line removed; and the userinfo cut from every `http://`/`https://`
  URL anywhere in the file, section names included (`[url "https://user:token@host/"]` →
  `[url "https://host/"]`). ssh remotes are untouched. An importer need not repeat this; a writer must.
- Ends with two zero blocks.

## The sealed envelope

```
offset  size  field
0       8     magic          "DTEXPORT" (ASCII)
8       1     version        1
9       1     log2(N)        scrypt cost; 17 when written
10      1     r              scrypt block size; 8 when written
11      1     p              scrypt parallelism; 1 when written
12      4     chunk size     uint32 big-endian; 65536 when written
16      16    salt           random
32      7     nonce prefix   random
39      1     reserved       0
40      32    header MAC     HMAC-SHA256(mac key, bytes 0..39)
72      …     chunks
```

**Keys.** `scrypt(passphrase NFC-normalised as UTF-8, salt, N = 2^log2N, r, p, dkLen = 64)`; bytes
0..31 are the AES-256-GCM key, bytes 32..63 the HMAC key. The parameters are read before the MAC can be
checked (the MAC needs the key they derive), so they are untrusted: a version-1 reader accepts
**exactly** `log2N = 17`, `r = 8`, `p = 1` and a chunk size of 65536, and refuses anything else before
running scrypt or asking for the passphrase. A future version that wants other costs is a new
version number.

**Header MAC.** Checked (constant time) before any chunk is opened. A mismatch means a wrong passphrase
or a damaged header, and nothing is written.

**Chunks.** The gzip stream is cut into chunks of exactly `chunk size` bytes, the last one shorter
(possibly empty — a final chunk always exists). Each is sealed with AES-256-GCM, no additional data:

```
nonce (12 bytes) = nonce prefix (7) ‖ chunk index (uint32 big-endian, from 0) ‖ final flag (1: 0x01 on the last chunk, else 0x00)
chunk on disk    = ciphertext ‖ 16-byte GCM tag
```

A reader takes `chunk size + 16` bytes at a time while more follows, and treats whatever remains at the
end (16 to `chunk size + 16` bytes) as the final chunk. So a flipped byte, a reordered or dropped chunk,
a file cut at any point — including exactly at a chunk boundary — and bytes appended after the final
chunk all fail authentication.

## The passphrase

The owner's. Read from `DT_EXPORT_PASSPHRASE` in the process environment, or asked at a terminal
without echo (twice on export). Never a command-line argument. At least 8 characters on export.

## Import is two passes

Pass 1 reads the whole file — every chunk authenticated, every entry checked — and writes nothing.
Then the target folders are checked (each on a real filesystem, not the container's own layer; each
empty unless `--replace`, which empties it). Pass 2 reads the file again, checking again, and uploads.
