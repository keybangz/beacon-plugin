/**
 * Test performance reporter
 * Generates performance report after test runs
 */
const fs = require('fs');
const path = require('path');

// Read Vitest coverage output
const coveragePath = path.join(__dirname, '..', 'coverage', 'coverage-summary.json');

try {
  if (fs.existsSync(coveragePath)) {
    const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
    
    console.log('\n📊 TEST PERFORMANCE REPORT');
    console.log('='.repeat(50));
    
    // Calculate totals
    const totals = coverage.total;
    
    console.log(`\n📈 COVERAGE SUMMARY`);
    console.log(`Lines: ${totals.lines.pct} (${totals.lines.covered}/${totals.lines.total})`);
    console.log(`Functions: ${totals.functions.pct} (${totals.functions.covered}/${totals.functions.total})`);
    console.log(`Branches: ${totals.branches.pct} (${totals.branches.covered}/${totals.branches.total})`);
    console.log(`Statements: ${totals.statements.pct} (${totals.statements.covered}/${totals.statements.total})`);
    
    // Performance metrics
    console.log(`\n⚡ PERFORMANCE METRICS`);
    console.log(`Test files: ${Object.keys(coverage).length - 1}`);
    
    // Look for slowest tests
    let slowestFile = '';
    let highestMisses = 0;
    
    for (const [file, data] of Object.entries(coverage)) {
      if (file === 'total') continue;
      
      const misses = data.lines.total - data.lines.covered;
      if (misses > highestMisses) {
        highestMisses = misses;
        slowestFile = file;
      }
    }
    
    if (slowestFile) {
      console.log(`\n🔍 COVERAGE GAPS`);
      console.log(`File with most uncovered lines: ${path.basename(slowestFile)}`);
      console.log(`Uncovered lines: ${highestMisses}`);
    }
    
    console.log('\n✅ Test performance report generated!\n');
  } else {
    console.log('\n⚠️  Coverage report not found at:', coveragePath);
    console.log('Run tests with coverage enabled to generate performance report.\n');
  }
} catch (error) {
  console.error('\n❌ Error generating test performance report:', error.message);
  process.exit(1);
}