import fs from 'node:fs';

const id = 'fd4fd30a';
const base = `E:/my/iceCoderCache/sessions/${id}`;
const ui = JSON.parse(fs.readFileSync(`${base}.json`, 'utf8'));
const structured = JSON.parse(fs.readFileSync(`${base}.structured.json`, 'utf8'));
const cp = JSON.parse(fs.readFileSync(`${base}.checkpoint.json`, 'utf8'));

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (typeof b === 'string' ? b : (b && b.text) || '')).join('\n');
}

console.log('=== checkpoint loop ===');
console.log('top keys', Object.keys(cp));
if (cp.loop) console.log('loop', JSON.stringify(cp.loop, null, 2));
function findRound(obj, path, depth) {
  if (!obj || typeof obj !== 'object' || depth > 4) return;
  if (obj.currentRound != null) {
    console.log('found currentRound at', path, obj.currentRound, 'maxRounds', obj.maxRounds);
  }
  if (Array.isArray(obj)) return;
  for (const k of Object.keys(obj)) {
    if (k === 'messages' || k === 'toolCalls' || k === 'content') continue;
    findRound(obj[k], `${path}.${k}`, depth + 1);
  }
}
findRound(cp, 'cp', 0);

console.log('\n=== UI message order (non-trace) ===');
ui.forEach((m, i) => {
  if (m.role === 'tool_trace') return;
  console.log(i, m.role, m.id, `len=${String(m.content || '').length}`, String(m.content || '').slice(0, 60).replace(/\n/g, ' '));
});

console.log('\n=== tool_trace per parent ===');
const byP = {};
for (const t of ui) {
  if (t.role !== 'tool_trace') continue;
  const p = t.parentId;
  if (!byP[p]) byP[p] = { n: 0, names: {}, errors: 0, tests: 0 };
  byP[p].n += 1;
  byP[p].names[t.toolName] = (byP[p].names[t.toolName] || 0) + 1;
  if (t.status === 'error') byP[p].errors += 1;
  if (t.toolName === 'run_command' && /test|vitest|jest|npm test/i.test(t.detail || '')) byP[p].tests += 1;
}
console.log(JSON.stringify(byP, null, 2));

console.log('\n=== structured sequence ===');
structured.forEach((m, i) => {
  const text = extractText(m.content).replace(/\s+/g, ' ').slice(0, 80);
  const calls = (m.toolCalls || []).map((c) => c.name);
  const flags = [];
  const raw = extractText(m.content);
  if (m.role === 'user' && raw.includes('[System:')) flags.push('SYS');
  if (m.role === 'user' && /Skill/i.test(raw)) flags.push('SKILL');
  if (/compact|compaction|\[Context Compacted\]/i.test(raw)) flags.push('COMPACT');
  console.log(
    String(i).padStart(3),
    String(m.role).padEnd(9),
    `calls=${String(calls.length).padStart(2)}`,
    flags.join(','),
    calls.join(',') || text,
  );
});

console.log('\n=== structured user texts ===');
structured.filter((m) => m.role === 'user').forEach((m, i) => {
  const t = extractText(m.content).replace(/\s+/g, ' ');
  const sys = t.includes('[System:');
  console.log(i, sys ? 'INJECT' : 'REAL ', `len=${t.length}`, t.slice(0, 100));
});

const asst = structured.filter((m) => m.role === 'assistant');
console.log('\n=== assistant rounds ===');
console.log('assistants', asst.length);
console.log('with toolCalls', asst.filter((a) => (a.toolCalls || []).length).length);
console.log('toolCall total', asst.reduce((n, a) => n + (a.toolCalls || []).length, 0));
console.log('without toolCalls', asst.filter((a) => !(a.toolCalls || []).length).length);
