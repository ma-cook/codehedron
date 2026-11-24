const PLAN_RUN_PATTERNS = [
  /\b(?:work|go|walk|run)\s+(?:through|thru)\s+(?:the\s+)?plan\b/i,
  /\b(?:work|go|walk|run)\s+(?:on|with)\s+(?:the\s+)?plan\b/i,
  /\b(?:execute|implement|start|begin|continue|resume|proceed\s+with|pick\s+up)\b.{0,40}\bplan\b/i,
  /\b(?:start|begin|execute|do|work\s+on|pick\s+up)\s+(?:the\s+)?(?:first|next)\s+(?:plan\s+)?task\b/i,
  /\b(?:first|next)\s+plan\s+task\b/i,
];

const QUESTION_PREFIX = /^\s*(?:what|which|who|where|when|why|how|show|list|tell|explain|describe|summarize)\b/i;

export function isPlanRunRequest(text) {
  if (!text || QUESTION_PREFIX.test(text)) return false;
  return PLAN_RUN_PATTERNS.some((pattern) => pattern.test(text));
}

export function resolvePlanRunRequest(text, planState) {
  if (!isPlanRunRequest(text)) return null;

  const plan = planState?.plan;
  if (!plan) {
    return { error: 'No active plan in this space. Create a plan in Plan mode first.' };
  }

  const activeTask = (planState.tasks || []).find(
    (task) => task.status === 'working_on' || task.status === 'to_review'
  );
  if (activeTask) {
    return {
      error: 'A plan task is already active. Finish or review it before starting another.',
    };
  }

  const completedIds = new Set(
    (planState.tasks || [])
      .filter((task) => task.status === 'completed')
      .map((task) => task.id)
  );

  const todoTasks = (planState.tasks || [])
    .filter((task) =>
      task.status === 'todo' &&
      (task.dependsOn || []).every((id) => completedIds.has(id))
    )
    .sort((a, b) => {
      const orderDiff = (a.sortOrder || 0) - (b.sortOrder || 0);
      if (orderDiff !== 0) return orderDiff;
      return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
    });

  if (todoTasks.length === 0) {
    return { error: 'All plan tasks are complete. Add another task to keep working.' };
  }

  const task = todoTasks[0];
  const remainingTasks = todoTasks.slice(1);

  return {
    plan,
    task,
    prompt: buildPlanRunPrompt(plan, task, remainingTasks),
  };
}

export function buildPlanRunPrompt(plan, task, remainingTasks = []) {
  const lines = [
    `Execute the next task in the existing plan "${plan.title}".`,
    '',
    `Current task: ${task.text}`,
    '',
    'Instructions:',
    '- Work only on the current task. Do not start the remaining tasks.',
    '- Do not call create_plan or add_task. Use the existing plan.',
    `- When the current task is fully implemented, call complete_task("${task.id}").`,
  ];

  if (remainingTasks.length > 0) {
    lines.push('');
    lines.push('Remaining tasks after this one:');
    remainingTasks.forEach((item, index) => {
      lines.push(`${index + 2}. ${item.text}`);
    });
  }

  return lines.join('\n');
}

export function buildOrchestratedPlanRunPrompt(plan, task) {
  return [
    `Execute the next task in the existing plan "${plan.title}".`,
    '',
    `Current task: ${task.text}`,
    '',
    'Instructions:',
    '- Work only on the current task. Do not start or describe other plan tasks.',
    '- Do not call create_plan, add_task, complete_task, or any plan editing tool.',
    '- Read the relevant files before editing. Use the edit tool with exact current text.',
    '- Produce the complete, final content for every file you create or change.',
    '- Do not create a branch, commit, push, or open a pull request. The runner handles delivery.',
    '- Do not output SEARCH/REPLACE markers in the final file content.',
  ].join('\n');
}
