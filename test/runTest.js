/**
 * VS Code Extension Integration Test Runner
 * No workspace argument — avoids VS Code 1.110.1 treating bare dirs as Node module entries.
 */
const path = require('path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '..');
    const extensionTestsPath = path.resolve(__dirname, 'suite');

    console.log('Extension path:', extensionDevelopmentPath);
    console.log('Test suite:', extensionTestsPath);

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        '--disable-gpu',
      ],
    });

    console.log('\n✅ VS Code integration tests completed successfully!');
  } catch (err) {
    console.error('Failed to run tests:', err);
    process.exit(1);
  }
}

main();
