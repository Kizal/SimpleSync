const vscode = require('vscode');
const { ok, equal } = require('assert');
const path = require('path');
const fs = require('fs');

async function run() {
  console.log('  SimpleSync — VS Code Integration Tests');

  // 1. Verify extension activation
  const ext = vscode.extensions.getExtension('sanket-jivtode.simplesync');
  ok(ext, 'Extension not found! Expected ID: sanket-jivtode.simplesync');
  
  if (!ext.isActive) {
    await ext.activate();
  }

  // 2. Verify all commands are registered
  const allCmds = await vscode.commands.getCommands(true);
  const csCmds = allCmds.filter(c => c.startsWith('simplesync.'));
  
  ok(csCmds.includes('simplesync.broadcast'), 'simplesync.broadcast command missing');
  ok(csCmds.includes('simplesync.connect'), 'simplesync.connect command missing');
  ok(csCmds.includes('simplesync.stop'), 'simplesync.stop command missing');
  ok(csCmds.includes('simplesync.pushBack'), 'simplesync.pushBack command missing');
  ok(csCmds.includes('simplesync.connectManual'), 'simplesync.connectManual command missing');
  ok(csCmds.includes('simplesync.disconnect'), 'simplesync.disconnect command missing');

  // Cleanup: ensure no broadcast is left running
  try {
    await vscode.commands.executeCommand('simplesync.stop');
  } catch (e) {}

  console.log('  ✓ All core commands verified.');
}

module.exports = { run };

