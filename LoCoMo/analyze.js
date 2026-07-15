const fs = require('fs');
const data = JSON.parse(fs.readFileSync('result_official_v13_full.json', 'utf-8'));

console.log('=== Summary ===');
console.log(`Total: ${data.summary.total_questions}`);
console.log(`Passed: ${data.summary.passed}`);
console.log(`Failed: ${data.summary.failed}`);
console.log(`Accuracy: ${data.summary.overall_accuracy}%`);

console.log('\n=== By Category ===');
for (const [cat, info] of Object.entries(data.by_category)) {
  console.log(`Cat ${cat} (${info.name}): ${info.accuracy}% (${info.passed}/${info.total}), avg_score: ${info.avg_score}`);
}

console.log('\n=== By Sample ===');
for (const s of data.by_sample) {
  console.log(`${s.sample_id}: ${s.accuracy}% (${s.passed}/${s.total})`);
}

// Analyze failures
const failedByCat = {};
const scoreDist = {};

for (const detail of data.details) {
  for (const qa of detail.qa_results) {
    const cat = qa.category;
    if (!scoreDist[cat]) scoreDist[cat] = {};
    const bucket = Math.round(qa.score * 10) / 10;
    scoreDist[cat][bucket] = (scoreDist[cat][bucket] || 0) + 1;
    
    if (!qa.passed) {
      if (!failedByCat[cat]) failedByCat[cat] = [];
      failedByCat[cat].push({
        sample: detail.sample_id,
        question: qa.question.substring(0, 80),
        answer: qa.answer.substring(0, 60),
        response: (qa.response || 'EMPTY').substring(0, 100),
        score: qa.score,
        reason: (qa.reason || '').substring(0, 120)
      });
    }
  }
}

console.log('\n=== Score Distribution ===');
for (const cat of Object.keys(scoreDist).sort()) {
  console.log(`Cat ${cat}:`);
  const buckets = Object.entries(scoreDist[cat]).sort((a, b) => a[0] - b[0]);
  for (const [bucket, count] of buckets) {
    console.log(`  ${bucket}: ${count}`);
  }
}

console.log('\n=== Failed Samples (top 3 per category) ===');
for (const cat of Object.keys(failedByCat).sort()) {
  const cases = failedByCat[cat];
  console.log(`\n--- Cat ${cat} (${cases.length} failed) ---`);
  for (const c of cases.slice(0, 3)) {
    console.log(`  Q: ${c.question}`);
    console.log(`  A: ${c.answer}`);
    console.log(`  R: ${c.response}`);
    console.log(`  Score: ${c.score}`);
    console.log(`  Reason: ${c.reason}`);
    console.log();
  }
}
