// contract rule: YAML is parsed with the CORE schema — unquoted dates stay strings,
// never timestamp objects. ALL dreamteamer tooling loads YAML through here.
//
// The library is eemeli's `yaml` (js-yaml until 0.13). Same CORE contract on parse — pinned by
// test/unit/yaml.test.js, including cross-parse agreement with js-yaml, which the VS Code
// extension still uses for its pre-activation window — plus the one capability js-yaml never had:
// parseDoc/stringifyDoc carry a hand-authored file's COMMENTS through an edit. That capability is
// what the schema-ops scars demanded (renameCollection's header; upsertField, which used to
// normalize a descriptor and silently destroy every comment in it).
import YAML from 'yaml';

const PARSE = { schema: 'core' };
// singleQuote + lineWidth 120 match the js-yaml output every record on disk was written with, so
// the swap does not spray quote-style diffs over fields nobody touched. One accepted delta: js-yaml
// quoted ISO date-times, YAML 1.2 core does not need to — both readers parse either spelling as a
// string. aliasDuplicateObjects OFF: records are files a human reads, and `&ref_0` is not prose.
const STRINGIFY = { lineWidth: 120, singleQuote: true, aliasDuplicateObjects: false };

export const load = (text) => YAML.parse(text, PARSE);
export const dump = (obj, opts = {}) => YAML.stringify(obj, { ...PARSE, ...STRINGIFY, ...opts });

/** Comment-preserving document editing (schema-ops): parse once, edit nodes via setIn/deleteIn,
 *  serialize with stringifyDoc. Comments, key order and each collection's own flow/block style
 *  survive. NOT byte-precise — long plain scalars refold at lineWidth — which is why the
 *  three-scalar rename edit keeps its textual path (see schema-ops' setScalar header). */
export const parseDoc = (text) => YAML.parseDocument(text, PARSE);
export const stringifyDoc = (doc) => doc.toString(STRINGIFY);
