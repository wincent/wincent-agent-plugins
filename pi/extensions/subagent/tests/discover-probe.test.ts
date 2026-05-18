/**
 * One-off probe: print the agents the extension would discover in a real run.
 * Not really a test; an inspection tool. Asserts only that at least one
 * extension-bundled agent is found.
 */

import {strict as assert} from 'node:assert';
import {test} from 'node:test';

import {discoverAgents} from '../main/agents.js';

test('discoverAgents finds the extension-bundled agents', () => {
  const result = discoverAgents(process.cwd());
  console.log('  extensionDir:', result.extensionDir);
  console.log('  userDir:     ', result.userDir);
  console.log('  projectDir:  ', result.projectDir);
  console.log('  agents:');
  for (const a of result.agents) {
    console.log(`    - ${a.name} (${a.source}): ${a.description}`);
  }
  assert.ok(result.agents.length > 0, 'expected at least one bundled agent');
  const names = result.agents.map((a) => a.name).sort();
  assert.ok(names.includes('scout'));
  assert.ok(names.includes('linter'));
  assert.ok(names.includes('tester'));
  assert.ok(names.includes('reviewer'));
  assert.ok(names.includes('formatter'));
  assert.ok(names.includes('worker'));
});
