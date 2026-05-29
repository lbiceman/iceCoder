const fs = require('fs');
let c = fs.readFileSync('test/core/types.test.ts', 'utf8');
c = c.replace(
  'expect(adapter.chat).toBe(999);',
  'expect(adapter.chat).toBeUndefined();'
).replace(
  'expect(adapter.stream).toBe(999);',
  'expect(adapter.stream).toBeUndefined();'
);
fs.writeFileSync('test/core/types.test.ts', c);
console.log('Cycle 6 edit done');
