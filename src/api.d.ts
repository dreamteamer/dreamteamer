// The typed contract of `import … from 'dreamteamer'` (src/api.js). It re-exports the record half
// (`dreamteamer/records`, src/records-api.d.ts) and adds the workspace half. A test pins each runtime
// export list to its declaration, so a name added to one and not the other fails the suite.

export * from './records-api.js';
import type { Fields, Descriptor, Descriptors, Manifest, Store } from './records-api.js';

// ---- the workspace and extensions ------------------------------------------------------------------

export interface Workspace {
	/** absolute path of the workspace root */
	root: string;
	/** the workspace package.json */
	pkg: { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; dreamteamer?: Record<string, any>; [k: string]: unknown };
	/** the ACTIVATED extensions, present on a handle from `openWorkspace` */
	extensions?: LoadedExtension[];
}

/** What an extension's `activate(dt)` returns. Every key is optional. */
export interface Contribution {
	commands?: Record<string, { usage?: string; run(ws: Workspace, argv: string[]): number | void | Promise<number | void> }>;
	sourceKinds?: (string | { kind: string; exclude?: string[] })[];
	analyze?(draft: CompileDraft): { errors?: string[]; warnings?: string[]; notes?: string[] } | void;
	harnesses?: Record<string, (ctx: HarnessContext) => { blocks?: Record<string, string | null>; summary?: string } | void>;
	orientation?: string | ((ctx: { entries: Map<string, Entry> }) => string);
	hooks?: Record<string, string>;
	/** cross-record rules: `dt check` reports what it returns after the schema's violations */
	check?(ctx: ExtensionContext): { file?: string; message: string }[] | void | Promise<{ file?: string; message: string }[] | void>;
	/** machine checks: `dt doctor` renders the rows as one capability named after the extension */
	doctor?(ctx: ExtensionContext): DoctorRow[] | void | Promise<DoctorRow[] | void>;
}
export interface DoctorRow { label: string; state: 'ok' | 'warn' | 'bad'; detail?: string; fix?: string }
export interface ExtensionContext { root: string; ws: Workspace; dt: typeof import('./api.js') }
export type Activate = (dt: typeof import('./api.js')) => Contribution | Promise<Contribution>;
export interface LoadedExtension {
	name: string;
	version: string;
	commands: NonNullable<Contribution['commands']>;
	sourceKinds: { kind: string; exclude: string[]; extension: string }[];
	analyze: Contribution['analyze'] | null;
	harnesses: NonNullable<Contribution['harnesses']>;
	orientation: Contribution['orientation'] | null;
	hooks: Record<string, string>;
	check: Contribution['check'] | null;
	doctor: Contribution['doctor'] | null;
}
export type Entry = { sources: { path: string; hash: string }[]; bytes: Buffer };
export interface CompileDraft {
	/** runtime-relative path → staged entry; read-only */
	readonly entries: Map<string, Entry>;
	/** the FINAL merged descriptors */
	readonly descriptors: Descriptors;
	readonly modules: { id: string; name: string; root: string; channel: 'inline' | 'git' | 'npm' }[];
	/** names only — never values */
	readonly declaredVars: string[];
	readonly declaredEnv: string[];
	readonly previousManifest: Manifest | null;
	/** parse one staged YAML entry, with its source path in any error */
	parse(runtimePath: string): any;
}
export interface HarnessContext {
	entries: Map<string, Entry>;
	version: string;
	collections: { name: string; generated: boolean; systemGroup: boolean; description: string; module: string; sensitive: boolean; sensitiveFields: string[] }[];
	modules: { id: string; title: string; description: string; path: string }[];
}

export const EXTENSION_API: 1;
export function openWorkspace(start?: string): Promise<Workspace & { extensions: LoadedExtension[] }>;
export function findWorkspace(start?: string): Workspace;
/** every extension's `check` contribution on `ws`, in the shape `check(ws, { extra })` takes */
export function contributedViolations(ws: Workspace): Promise<{ file: string; msg: string }[]>;
export function declaredExtensions(ws: Workspace): { name: string; version: string; dir: string; entry: string }[];
export const engineBin: string;
export const engineRoot: string;

export function envContext(ws: Workspace): unknown;
export function renderTemplate(template: string, ctx: unknown): string;
export function parseEnvValues(text: string): Map<string, string>;
export function satisfies(version: string, range: string): boolean | null;

// ---- the compiler, schema and module operations --------------------------------------------------

/** throws CompileError on a bad source; prints its summary; returns 0 */
export function compile(ws: Workspace): 0;
export function staleness(root: string): { compiled: boolean; stale: string[]; manifest?: Manifest; message?: string };
export function warnIfStale(root: string): ReturnType<typeof staleness>;
export function discoverModules(root: string, pkg: Workspace['pkg']): { modules: { name: string; root: string; channel: string }[]; shadows: unknown[]; disabledModules: string[] };
export class CompileError extends Error {}
export const KINDS: readonly string[];
export const MANAGED_BLOCKS: readonly { id: 'orientation' | 'instructions'; begin: string; end: string }[];
type SchemaOp = (ws: Workspace, store: Store, ...args: any[]) => any;
export const createCollection: SchemaOp, removeCollection: SchemaOp, renameCollection: SchemaOp, moveCollection: SchemaOp, setCollectionScalars: SchemaOp;
export const addField: SchemaOp, updateField: SchemaOp, removeField: SchemaOp, removeFieldPlan: SchemaOp, renameField: SchemaOp, renameFieldPlan: SchemaOp;
export function fieldDef(store: Store, flags: Record<string, unknown>, collection: string): any;
export function statedKeywords(flags: Record<string, unknown>): any;
export const saveUiView: SchemaOp, removeUiView: SchemaOp;
export const createModule: SchemaOp, setModule: SchemaOp, renameModule: SchemaOp, removeModule: SchemaOp;
export const createSkill: SchemaOp, refuseHandAuthored: SchemaOp, removeEntity: SchemaOp, renameEntity: SchemaOp, setEntityFrontmatter: SchemaOp;
export function init(opts?: { flags?: Record<string, string> }): 0;
export function ensureRepo(ws: Workspace, id: string): { path: string; cloned: boolean };
export function ensureAllRepos(ws: Workspace): { path: string; cloned: boolean }[];
export function listRepos(ws: Workspace): { id: string; path: string; present: boolean; unresolved?: string }[];
export function installClone(ws: Workspace, url: string, name?: string): number;

// ---- the checkout -------------------------------------------------------------------------------------

export function describeCheckout(root: string, git?: (args: string[], cwd: string) => string): { root: string; kind: 'primary' | 'linked'; gitDir: string; commonDir: string; primary: string; insideRoot: boolean };
export function installCommand(ws: Workspace, argv: string[], opts?: { open?: (at: string) => Promise<Workspace> }): Promise<number>;
export function resolveNpm(execPath?: string, env?: NodeJS.ProcessEnv): string | null;
export function childEnv(): NodeJS.ProcessEnv;
export function readHookInput(stdinText: string): { cwd: string | null; name: string | null; raw: Record<string, unknown> };
export function readStdin(isTTY?: boolean): string;

// ---- CLI helpers ------------------------------------------------------------------------------------------

/** write `text` plus a trailing newline, synchronously, looping on short writes — safe before process.exit */
export function emit(text: string, fd?: number): void;
export function parseArgs(argv: string[]): { flags: Record<string, string | boolean | string[]>; pos: string[] };
