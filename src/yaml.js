// contract rule: YAML is parsed with the CORE schema — unquoted dates stay strings,
// never timestamp objects. ALL dreamteamer tooling loads YAML through here.
import yaml from 'js-yaml';

export const load = (text) => yaml.load(text, { schema: yaml.CORE_SCHEMA });
export const dump = (obj, opts = {}) => yaml.dump(obj, { lineWidth: 120, ...opts });
