const APPROVAL_MODES = Object.freeze(['supervised', 'safe-auto', 'autonomous-local', 'read-only']);

const SAFE_COMMANDS = new Map([
  ['git status', { executable: 'git', args: ['status', '--short', '--branch'], risk: 'read-only' }],
  ['git diff', { executable: 'git', args: ['diff', '--stat'], risk: 'read-only' }],
  ['npm test', { executable: 'npm', args: ['test'], risk: 'validation' }],
  ['npm run test', { executable: 'npm', args: ['run', 'test'], risk: 'validation' }],
  ['npm run lint', { executable: 'npm', args: ['run', 'lint'], risk: 'validation' }],
  ['npm run typecheck', { executable: 'npm', args: ['run', 'typecheck'], risk: 'validation' }],
  ['npm run check', { executable: 'npm', args: ['run', 'check'], risk: 'validation' }],
  ['npm run build', { executable: 'npm', args: ['run', 'build'], risk: 'validation' }]
]);

function commandDecision(raw, approvalMode = 'safe-auto') {
  if (!APPROVAL_MODES.includes(approvalMode)) throw new Error('Unknown Project Head approval mode.');
  const command = String(raw || '').trim().replace(/\s+/g, ' ');
  const definition = SAFE_COMMANDS.get(command);
  if (!definition) return { allowed: false, approvalRequired: true, risk: 'blocked', reason: 'Command is not in Noor’s typed safe-command allowlist.' };
  if (approvalMode === 'read-only' && definition.risk !== 'read-only') return { allowed: false, approvalRequired: true, risk: definition.risk, reason: 'Read Only mode blocks commands that may create project output.' };
  return { allowed: true, approvalRequired: approvalMode === 'supervised' && definition.risk !== 'read-only', command, ...definition };
}

module.exports = { APPROVAL_MODES, SAFE_COMMANDS, commandDecision };
