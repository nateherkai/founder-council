import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const id = `__resume-smoke-${process.pid}`;
const dir = path.join(ROOT, 'sessions', id);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const weights = {
  graham: { weight: 3, reason: 'market feedback' },
  buffett: { weight: 2, reason: 'downside check' },
};
fs.writeFileSync(path.join(dir, 'council.json'), JSON.stringify({
  title: 'Resume smoke', decision: 'A or B?', mode: 'quick', runner: 'hybrid',
  options: [{ id: 'A', label: 'A' }, { id: 'B', label: 'B' }],
  weights, seats: ['graham', 'buffett'], brief: 'Synthetic CI fixture.', assumptions: []
}, null, 2));
fs.writeFileSync(path.join(dir, 'round-1.md'), `# Round 1\n\n## Paul Graham (weight 3)\n\nSEAT: GRAHAM (Product & startups)\nSTANCE: Yes\nOPTION SCORES: A 8/10 · B 3/10\nPILLAR SCORE: 8/10\nCONFIDENCE: 4/5\nRUIN RISK: none\nDOOR: two-way\n\nTHE CALL: Choose A.\nWHY:\n1. Fast feedback.\n2. Reversible.\n3. Cheap.\nTHE RISK I SEE: Weak signal.\nWHAT WOULD CHANGE MY MIND: No response.\nWHAT I'D DO THIS WEEK: Test A.\nQUESTION FOR THE FOUNDER: What happened?\n`);

try {
  const missing = path.join(ROOT, '__missing_gemini__.js');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'hybrid', 'runner.mjs'), '--resume', id], {
    cwd: ROOT,
    env: { ...process.env, GEMINI_CLI_ENTRY: missing, GEMINI_CONCURRENCY: '1' },
    encoding: 'utf8'
  });
  if (r.status === 0) throw new Error('resume smoke unexpectedly completed');
  if (!r.stdout.includes('Gemini 1.Buffett')) throw new Error('missing seat was not scheduled');
  if (r.stdout.includes('Gemini 1.Graham')) throw new Error('saved seat was rerun');
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'round-1.json'), 'utf8'));
  if (!state.cards?.graham || state.cards?.buffett) throw new Error('legacy round recovery checkpoint is wrong');
  console.log('Hybrid resume smoke OK: recovered Graham and scheduled only Buffett');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
