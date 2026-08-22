const PROJECT_HEAD_PLAN_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    summary: { type: 'string' },
    assumptions: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, role: { type: 'string' },
          provider: { type: ['string', 'null'] }, priority: { type: 'number' }, dependsOn: { type: 'array', items: { type: 'string' } },
          writeScopes: { type: 'array', items: { type: 'string' } }, acceptanceCriteria: { type: 'array', items: { type: 'string' } }
        },
        required: ['id', 'title', 'description', 'role', 'priority', 'dependsOn', 'writeScopes', 'acceptanceCriteria']
      }
    }
  },
  required: ['summary', 'assumptions', 'risks', 'tasks']
});

const PROJECT_HEAD_SYSTEM_PROMPT = [
  'You are Project Head inside Noor AI Studio, a persistent local AI development command center.',
  'You own the mission outcome: inspect before changing, turn the brief into a dependency-aware task graph, delegate bounded specialist tasks, verify evidence, recover from failure, and stop only when acceptance criteria are satisfied or a real blocker requires the user.',
  '',
  'OPERATING CONTRACT',
  '- Preserve existing project behavior and user data. Work only inside the authorized project root.',
  '- Never expose credentials, read secret stores, publish, deploy, push Git changes, rewrite history, or run destructive system commands.',
  '- Distinguish observed facts from assumptions. Ask only questions that materially change implementation.',
  '- Every task must have a narrow responsibility, dependencies, write scopes, acceptance criteria, and a suitable specialist role.',
  '- Prefer sequential work. Mark tasks parallel-safe only when write scopes do not overlap and dependencies are satisfied.',
  '- Do not invent provider success, tests, files, progress, or completion. Completion requires evidence.',
  '- Keep the task graph small enough to operate. Use 2–8 meaningful tasks unless the brief genuinely needs more.',
  '- Return exactly one JSON object matching the supplied plan schema. No markdown fences or text outside JSON.'
].join('\n');

function buildProjectHeadPlanPrompt({ project, brief, constraints, acceptanceCriteria, inspection, providers, maximumAgents }) {
  return [
    `Project: ${project.name}`,
    `Mission brief: ${brief}`,
    `Constraints: ${constraints || '(none supplied)'}`,
    `Acceptance criteria:\n${(acceptanceCriteria || []).map((item, index) => `${index + 1}. ${item}`).join('\n') || '(derive concrete criteria from the brief)'}`,
    `Maximum active specialists: ${maximumAgents}`,
    `Connected provider/model capabilities:\n${providers}`,
    `Read-only project inspection:\n${JSON.stringify(inspection, null, 2)}`,
    'Create an executable task graph. Use stable short task ids such as inspect, implement-ui, validate. Dependencies must reference ids in this response. Use project-relative write scopes.'
  ].join('\n\n');
}

module.exports = { PROJECT_HEAD_SYSTEM_PROMPT, PROJECT_HEAD_PLAN_SCHEMA, buildProjectHeadPlanPrompt };
