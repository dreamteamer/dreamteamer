/**
 * Where a declared repo's working tree lives. Materializes nothing, so callers can ask without
 * cloning (that is how `status` reports presence).
 *
 * The engine deliberately does NOT know what `identity` means: a workspace may use it to select a
 * `~/.gitconfig` includeIf folder so the clone commits as the right git user, but that resolution
 * happens entirely outside the engine. Here it is just a path segment.
 *
 * ⚠ `path` AND `repos-path` ARE TEMPLATES, rendered here. They were joined onto the workspace root
 * as literal text, so the one thing an attached repo most often IS — a checkout somewhere else on
 * this machine, named by an `.env` key because the place differs per machine — was inexpressible.
 * `--path '${env:REPOS_FOLDER}/acme'` did not fail; `ensure` cloned into a directory whose name was
 * the eleven characters `${env:REPOS_FOLDER}`, inside the workspace. The record still carries the
 * template verbatim, as every record does; this is the read side rendering it at the point of need,
 * against the same context `dt resolve` builds. `path.resolve`, not `join`, because an absolute
 * rendering has to escape the workspace while a plain relative override still anchors to it.
 *
 * It THROWS on an undeclared or valueless var, which is `renderTemplate`'s contract and the right
 * one here: a repo path this machine cannot state is not a repo path to guess at. `listRepos`
 * catches per record so one such repo cannot take a whole listing down with it.
 */
/** A `repos` record's fields: where it clones from, and where it goes (`path`, else `<repos_path>/[<identity>/]<name>`). */
export type RepoFields = { url?: string; ref?: string; path?: string; name?: string; identity?: string }
