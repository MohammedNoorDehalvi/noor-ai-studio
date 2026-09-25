const assert = require('node:assert/strict');
const {
  filterCommands,
  score,
  loadRecentCommandIds,
  recordRecentCommand,
  clearRecentCommandIds,
  RECENT_STORAGE_KEY,
  MAX_RECENT_COMMANDS
} = require('../renderer/command-palette.js');

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    dump(key) { return values.get(key) || null; }
  };
}

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

const storage = memoryStorage();
assert.deepEqual(loadRecentCommandIds(storage), []);
recordRecentCommand('providers', storage);
recordRecentCommand('settings', storage);
recordRecentCommand('providers', storage);
assert.deepEqual(loadRecentCommandIds(storage), ['providers', 'settings']);
assert.ok(JSON.parse(storage.dump(RECENT_STORAGE_KEY)).length <= MAX_RECENT_COMMANDS);

const recent = filterCommands('', storage);
assert.equal(recent[0].id, 'providers');
assert.equal(recent[0].group, 'Recent');
assert.ok(recent.some((item) => item.id === 'settings'));
assert.equal(recent.filter((item) => item.id === 'providers').length, 1);

clearRecentCommandIds(storage);
assert.deepEqual(loadRecentCommandIds(storage), []);
assert.equal(storage.dump(RECENT_STORAGE_KEY), null);

console.log('Command palette smoke tests passed.');
