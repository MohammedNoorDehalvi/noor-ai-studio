const assert = require('node:assert/strict');
const { filterCommands, score } = require('../renderer/command-palette.js');

const providerCommands = filterCommands('provider').map((item) => item.id);
assert.ok(providerCommands.includes('providers'));
assert.ok(providerCommands.includes('refresh-providers'));

const projectMatches = filterCommands('projects').map((item) => item.id);
assert.ok(projectMatches.includes('projects'));

assert.ok(score({
  title: 'Go to Projects',
  hint: 'Browse local projects',
  keywords: 'workspace'
}, 'projects') > 0);
assert.equal(score({
  title: 'Go to Projects',
  hint: 'Browse local projects',
  keywords: 'workspace'
}, 'not-a-real-command'), 0);

console.log('Command palette smoke tests passed.');
