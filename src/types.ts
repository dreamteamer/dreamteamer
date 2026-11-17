// The contracts between the engine's parts. Everything else imports from here.

/** One installed package (or local folder) that carries a `dreamteamer` key in its package.json. Read-only input. */
export interface Module {
  name: string;
  version: string;
  dir: string;
  origin: 'npm' | 'workspace';
  title?: string;
  namespaces: string[];
  dependencies: string[];
  /** contract elements this engine saw but does not implement (extension, nav, setup, …) */
  unsupported: string[];
}

export interface Field {
  /** a scalar name, a collection name, or a list of collection names (a reference to any of them) */
  type: string | string[];
  many?: boolean;
  required?: boolean;
  default?: unknown;
  enum?: unknown[];
  pattern?: string;
  body?: boolean;
  mirror_of?: string;
  description?: string;
  [key: string]: unknown;
}

export interface Storage {
  path: string;
  format: 'md' | 'yaml' | 'json' | 'binary';
  suffix?: string;
  shape?: 'file' | 'folder';
  entry?: string;
}

export interface Collection {
  name: string;
  module: string;
  description?: string;
  use_when?: string;
  storage: Storage;
  ids: { from: string[]; pattern?: string };
  fields: Record<string, Field>;
  /** modules whose overlays or mixins contributed fields */
  contributors: string[];
}

export type Severity = 'error' | 'warning';
export interface Issue { severity: Severity; where: string; message: string }

export interface Skill { name: string; module: string; description: string; path: string }

/** The resolved workspace: what every adapter (CLI, harness instructions, UI) reads. Derived, reproducible. */
export interface Model {
  root: string;
  modules: Module[];
  collections: Record<string, Collection>;
  skills: Skill[];
  /** ids another repo vouches for: collection → ids */
  exports: Record<string, string[]>;
  issues: Issue[];
}

export interface DtRecord {
  ref: string;            // <collection>/<id>
  collection: string;
  id: string;
  path: string;           // absolute file path
  data: Record<string, unknown>; // frontmatter fields + the body field
  mtimeMs: number;
}

export class DtError extends Error {
  issues: Issue[];
  constructor(message: string, issues: Issue[] = []) { super(message); this.issues = issues; }
}
