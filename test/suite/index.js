/**
 * VS Code Integration Test Suite — runs inside a real VS Code instance.
 * Tests extension activation, command registration, and core functionality.
 */
const vscode = require('vscode');
let pass = 0, fail = 0;

function ok(label, condition) {
  if (condition) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  CodeSync — VS Code Integration Tests');
  console.log('═══════════════════════════════════════════════════════\n');

  // ─── TEST 1: Extension Discovery ────────────────────────────
  console.log('━━━ TEST 1: Extension Discovery ━━━');
  const ext = vscode.extensions.getExtension('sanke.codesync');
  ok('Extension found by ID "sanke.codesync"', !!ext);

  if (!ext) {
    console.log('  ⚠️  Extension not found. Listing all extensions:');
    vscode.extensions.all
      .filter(e => !e.id.startsWith('vscode.'))
      .forEach(e => console.log(`    - ${e.id}`));
    throw new Error('Extension not found');
  }

  // ─── TEST 2: Activation ─────────────────────────────────────
  console.log('\n━━━ TEST 2: Extension Activation ━━━');
  if (!ext.isActive) {
    await ext.activate();
  }
  ok('Extension is active', ext.isActive);

  // ─── TEST 3: Command Registration ──────────────────────────
  console.log('\n━━━ TEST 3: Command Registration ━━━');
  const allCmds = await vscode.commands.getCommands(true);
  const csCmds = allCmds.filter(c => c.startsWith('codesync.'));

  ok('codesync.broadcast', csCmds.includes('codesync.broadcast'));
  ok('codesync.connect', csCmds.includes('codesync.connect'));
  ok('codesync.stop', csCmds.includes('codesync.stop'));
  ok('codesync.pushBack', csCmds.includes('codesync.pushBack'));
  ok('codesync.connectManual', csCmds.includes('codesync.connectManual'));
  ok('codesync.disconnect', csCmds.includes('codesync.disconnect'));
  ok('All 6 commands registered', csCmds.length === 6);
  console.log(`    Commands: ${csCmds.join(', ')}`);

  // ─── TEST 4: Stop Command (should work even when not broadcasting)
  console.log('\n━━━ TEST 4: Stop Command (idempotent) ━━━');
  try {
    await vscode.commands.executeCommand('codesync.stop');
    await sleep(500);
    ok('Stop command ran without error', true);
  } catch (e) {
    ok('Stop command callable', false);
    console.log(`    Error: ${e.message}`);
  }

  // ─── TEST 5: Extension Package Metadata ─────────────────────
  console.log('\n━━━ TEST 5: Extension Metadata ━━━');
  const pkg = ext.packageJSON;
  ok('Name = codesync', pkg.name === 'codesync');
  ok('Display name = CodeSync', pkg.displayName === 'CodeSync');
  ok('Has activationEvents', Array.isArray(pkg.activationEvents) || pkg.activationEvents === '*' || pkg.contributes);
  ok('Has 6 contributed commands', pkg.contributes?.commands?.length === 6);
  ok('Main entry = ./out/extension.js', pkg.main === './out/extension.js');

  // ─── Summary ────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`TOTAL: ${pass + fail} tests | ${pass} passed | ${fail} failed`);
  console.log(fail > 0 ? 'STATUS: ❌ SOME TESTS FAILED' : 'STATUS: ✅ ALL VS CODE INTEGRATION TESTS PASSED');
  console.log('═══════════════════════════════════════════════════════\n');

  if (fail > 0) throw new Error(`${fail} tests failed`);
}

module.exports = { run };
