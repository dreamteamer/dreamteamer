// Compile: project the resolved model into derived, gitignorable files. Never touches git, never writes outside <root>/.dt.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Model } from './types.ts';

export function instructions(model: Model): string {
  const lines = ['# Workspace instructions (generated — do not edit)', '',
    'Records are `<id>.<suffix>.<ext>` files; references are `<collection>/<id>`. Use `dt list|get|add|set|rm|check`.', '', '## Collections', ''];
  for (const c of Object.values(model.collections).sort((a, b) => a.name.localeCompare(b.name))) {
    const required = Object.entries(c.fields).filter(([, f]) => f.required && f.default === undefined).map(([n]) => n);
    lines.push(`- **${c.name}** (${c.module}) — ${c.description ?? ''}`.trimEnd());
    if (c.use_when) lines.push(`  use when: ${c.use_when}`);
    lines.push(`  stored: ${c.storage.path} · required: ${required.join(', ') || 'none'}`);
  }
  lines.push('', '## Skills', '');
  for (const s of model.skills) lines.push(`- **${s.name}** (${s.module}) — ${s.description}`);
  return lines.join('\n') + '\n';
}

export function compile(model: Model): string[] {
  const out = join(model.root, '.dt');
  mkdirSync(out, { recursive: true });
  const files: Record<string, string> = {
    'model.json': JSON.stringify(model, null, 2) + '\n',
    'AGENTS.md': instructions(model),
    '.gitignore': '*\n',
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(out, name), text);
  return Object.keys(files).map((n) => join(out, n));
}
