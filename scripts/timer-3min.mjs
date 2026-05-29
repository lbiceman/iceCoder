const start = Date.now();
const DURATION = 180_000; // 3 minutes

console.log(`Timer started at ${new Date().toLocaleTimeString()}`);

const interval = setInterval(() => {
  const remaining = Math.ceil((DURATION - (Date.now() - start)) / 1000);
  if (remaining > 0) {
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    console.log(`${m}m ${s}s remaining...`);
  }
}, 30_000);

setTimeout(() => {
  clearInterval(interval);
  console.log(`3 minutes elapsed! Done at ${new Date().toLocaleTimeString()}`);
  process.exit(0);
}, DURATION);
