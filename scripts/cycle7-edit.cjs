const fs = require('fs');
let c = fs.readFileSync('test/core/types.test.ts', 'utf8');
c = c.replace(
  'expect(adapter.chat).toBeUndefined();',
  'expect(adapter.chat).toBe(999);'
).replace(
  'expect(adapter.stream).toBeUndefined();',
  'expect(adapter.stream).toBe(999);'
);
fs.writeFileSync('test/core/types.test.ts', c);
console.log('Cycle 7 edit done');
