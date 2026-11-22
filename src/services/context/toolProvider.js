import useDiagramStore from '../../stores/diagramStore';
import { REGISTRY } from './skillManager';

class ToolDefinition {
  constructor({ name, description, parameters, availableWhen, required }) {
    this.name = name;
    this.description = description;
    this.parameters = parameters;
    this.required = required;
    this.availableWhen = availableWhen ?? (() => true);
  }

  toToolSpec() {
    const props = {};
    const requiredParams = [];
    for (const [key, def] of Object.entries(this.parameters)) {
      props[key] = { type: def.type, description: def.description };
      if (def.required !== false) requiredParams.push(key);
    }
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: props,
          ...(requiredParams.length > 0 ? { required: requiredParams } : {}),
        },
      },
    };
  }
}

function hasLspMetadata() {
  try {
    const lsp = useDiagramStore.getState().lspMetadata;
    return !!(lsp?.definitions?.length || lsp?.references?.length || lsp?.hover?.length || lsp?.callGraph?.length);
  } catch { return false; }
}

function hasCommunities() {
  try {
    const communities = useDiagramStore.getState().communities;
    return !!(communities && communities.length > 0);
  } catch { return false; }
}

export const CONTROL_TOOLS = [
  new ToolDefinition({
    name: 'set_mode',
    description: 'Switch the harness tool set for the next round. "research" = all search/read/graph tools. "edit" = only edit, write, read_file, LSP verification, and set_mode. Call set_mode("edit") once you know the exact text for every change; set_mode("research") to search again.',
    parameters: {
      mode: { type: 'string', description: '"research" or "edit"' },
    },
    required: ['mode'],
  }),
  new ToolDefinition({
    name: 'ask_user',
    description: 'Ask the user ONE clarifying question and wait for their answer. Use only when a genuine ambiguity would change what you build; prefer mutually exclusive options. Not for permission or decisions you can make yourself.',
    parameters: {
      question: { type: 'string', description: 'The single question, short and specific.' },
      options: { type: 'string', required: false, description: 'Optional JSON array of 2-4 short option strings, e.g. ["Option A","Option B"]. Omit for free text.' },
      context: { type: 'string', required: false, description: 'Optional one-line note shown under the question.' },
    },
    required: ['question'],
  }),
];

export const NAVIGATION_TOOLS = [
  new ToolDefinition({
    name: 'quick_look',
    description: 'Preview the first/last N lines of a file. Faster than read_file for checking imports, exports, or structure.',
    parameters: {
      path: { type: 'string', description: 'File path relative to repo root' },
      head: { type: 'number', description: 'Lines from the top (default 40)' },
      tail: { type: 'number', description: 'Lines from the bottom (default 20, 0 disables)' },
    },
    required: ['path'],
  }),
  new ToolDefinition({
    name: 'file_outline',
    description: 'Structural outline of a file: functions, components, exports, hooks, state, with line numbers. Use FIRST before reading a file fully.',
    parameters: {
      path: { type: 'string', description: 'File path relative to repo root' },
    },
    required: ['path'],
  }),
  new ToolDefinition({
    name: 'read_file',
    description: 'Read file contents. Up to 8000 lines by default, lines prefixed with line numbers. Use offset/limit for large files.',
    parameters: {
      path: { type: 'string', description: 'File path relative to repo root' },
      offset: { type: 'number', description: 'Line to start from (default 1)' },
      limit: { type: 'number', description: 'Max lines (default 8000)' },
    },
    required: ['path'],
  }),
  new ToolDefinition({
    name: 'list_files',
    description: 'List files and subdirectories in a directory.',
    parameters: {
      path: { type: 'string', description: 'Directory path relative to repo root. Use "" for root.' },
    },
  }),
  new ToolDefinition({
    name: 'search_code',
    description: 'Search the repo for files matching a pattern or containing text. Returns matching paths and graph context.',
    parameters: {
      pattern: { type: 'string', description: 'Search term or glob pattern' },
    },
    required: ['pattern'],
  }),
];

export const GRAPH_TOOLS = [
  new ToolDefinition({
    name: 'get_node_info',
    description: 'Full details for a diagram node: type, file path, connections, parent, children.',
    parameters: {
      nodeId: { type: 'string', description: 'The node ID from the diagram' },
    },
    required: ['nodeId'],
  }),
  new ToolDefinition({
    name: 'get_dependencies',
    description: 'Show what depends on a node (upstream) or what it depends on (downstream).',
    parameters: {
      nodeId: { type: 'string', description: 'The node ID to check dependencies for' },
      direction: { type: 'string', enum: ['upstream', 'downstream', 'both'], description: '"upstream", "downstream", or "both" (default)' },
    },
    required: ['nodeId'],
  }),
  new ToolDefinition({
    name: 'find_path',
    description: 'Shortest data-flow path between two diagram nodes.',
    parameters: {
      source: { type: 'string', description: 'Starting node ID' },
      target: { type: 'string', description: 'Ending node ID' },
    },
    required: ['source', 'target'],
  }),
  new ToolDefinition({
    name: 'search_nodes',
    description: 'Search diagram nodes by name, type, or ID.',
    parameters: {
      query: { type: 'string', description: 'Search term matching node names, types, and IDs' },
    },
    required: ['query'],
  }),
];

export const COMMUNITY_TOOLS = [
  new ToolDefinition({
    name: 'get_community_info',
    description: 'Get architectural overview of a community: its summary, node count, key components, internal and external connections.',
    parameters: {
      communityId: { type: 'number', description: 'The community ID (number, e.g. 0, 1, 2...)' },
    },
    required: ['communityId'],
    availableWhen: hasCommunities,
  }),
  new ToolDefinition({
    name: 'get_community_nodes',
    description: 'List all nodes in a community with their types and file paths.',
    parameters: {
      communityId: { type: 'number', description: 'The ID of the community to list nodes for' },
    },
    required: ['communityId'],
    availableWhen: hasCommunities,
  }),
  new ToolDefinition({
    name: 'search_communities',
    description: 'Search communities by keyword (name, node types, file paths). Returns matching communities with summaries.',
    parameters: {
      query: { type: 'string', description: 'Search term (e.g. "auth", "database", "dashboard")' },
    },
    required: ['query'],
    availableWhen: hasCommunities,
  }),
];

export const LSP_TOOLS = [
  new ToolDefinition({
    name: 'get_lsp_definition',
    description: 'Resolve where an import resolves to across the codebase using LSP type information.',
    parameters: {
      query: { type: 'string', description: 'Import name, file name, or symbol name' },
    },
    required: ['query'],
    availableWhen: hasLspMetadata,
  }),
  new ToolDefinition({
    name: 'get_lsp_references',
    description: 'Find all files that reference a given symbol using LSP.',
    parameters: {
      query: { type: 'string', description: 'Symbol name, file name, or export name' },
    },
    required: ['query'],
    availableWhen: hasLspMetadata,
  }),
  new ToolDefinition({
    name: 'get_lsp_type_info',
    description: 'Get type signatures and documentation for a symbol from LSP.',
    parameters: {
      query: { type: 'string', description: 'Symbol name' },
    },
    required: ['query'],
    availableWhen: hasLspMetadata,
  }),
  new ToolDefinition({
    name: 'get_lsp_call_graph',
    description: 'Show the call graph for a function — who calls it, and what it calls.',
    parameters: {
      query: { type: 'string', description: 'Function name or file name' },
    },
    required: ['query'],
    availableWhen: hasLspMetadata,
  }),
  new ToolDefinition({
    name: 'get_lsp_overview',
    description: 'Get a summary of available LSP metadata.',
    parameters: {},
    availableWhen: hasLspMetadata,
  }),
];

export const MODIFICATION_TOOLS = [
  new ToolDefinition({
    name: 'edit',
    description: 'Replace an exact string in a file — more precise than regenerating a file. You MUST call read_file first to get the current content.',
    parameters: {
      filePath: { type: 'string', description: 'File path relative to repo root' },
      oldString: { type: 'string', description: 'The exact string to find and replace' },
      newString: { type: 'string', description: 'The replacement string' },
    },
    required: ['filePath', 'oldString', 'newString'],
  }),
  new ToolDefinition({
    name: 'write',
    description: 'Create a NEW file. Rejects paths that already exist — use edit for existing files.',
    parameters: {
      filePath: { type: 'string', description: 'File path relative to repo root' },
      content: { type: 'string', description: 'The complete file content' },
    },
    required: ['filePath', 'content'],
  }),
];

export const SUB_AGENT_TOOL = [
  new ToolDefinition({
    name: 'task',
    description: 'Spawn a read-only sub-agent to research a codebase question (reads files, searches code, queries the graph; cannot modify).',
    parameters: {
      prompt: { type: 'string', description: 'Clear, specific research question for the sub-agent' },
    },
    required: ['prompt'],
  }),
];

export const PLAN_TOOLS = [
  new ToolDefinition({
    name: 'create_plan',
    description: 'Start a new task plan for multi-step requests. Call first, then add_task per step.',
    parameters: {
      title: { type: 'string', description: 'Short title for the plan (e.g. "Refactor auth module")' },
    },
    required: ['title'],
  }),
  new ToolDefinition({
    name: 'add_task',
    description: 'Add a task to the active plan. Call create_plan first if none exists.',
    parameters: {
      text: { type: 'string', description: 'Description of the task to add' },
    },
    required: ['text'],
  }),
  new ToolDefinition({
    name: 'complete_task',
    description: 'Mark a task completed (task text partial match or ID).',
    parameters: {
      task: { type: 'string', description: 'Task text (partial match) or task ID to complete' },
    },
    required: ['task'],
  }),
  new ToolDefinition({
    name: 'get_plan',
    description: 'View the active plan and its tasks.',
    parameters: {},
  }),
];

export const SKILL_MANAGEMENT_TOOLS = [
  new ToolDefinition({
    name: 'list_skills',
    description: 'List available skills and their descriptions.',
    parameters: {},
  }),
  new ToolDefinition({
    name: 'activate_skill',
    description: 'Activate a skill by name to load its instructions and tools.',
    parameters: {
      skill_name: { type: 'string', description: 'The name of the skill to activate' },
    },
    required: ['skill_name'],
  }),
  new ToolDefinition({
    name: 'deactivate_skill',
    description: 'Deactivate a skill, removing its instructions and tools from the session.',
    parameters: {
      skill_name: { type: 'string', description: 'The name of the skill to deactivate' },
    },
    required: ['skill_name'],
  }),
];

// Whitelist for EDIT mode: the model can only modify files, read for exact
// oldString / verification, verify symbols via LSP, and switch modes. All
// search/list/graph/skill tools drop off until set_mode("research").
// Plan tools are always available in every mode.
const EDIT_MODE_TOOL_NAMES = new Set([
  'edit', 'write', 'read_file', 'set_mode', 'ask_user',
  'get_lsp_definition', 'get_lsp_references', 'get_lsp_type_info', 'get_lsp_call_graph', 'get_lsp_overview',
  'create_plan', 'add_task', 'complete_task', 'get_plan',
]);

// read_file is intentionally NOT in this list — in force-generation mode the
// LLM still needs read_file to get exact oldString for the edit tool and to
// verify its edits. Only broad search/list/graph tools are stripped.
const EXPLORATION_TOOL_NAMES = new Set([
  'search_code', 'list_files', 'file_outline', 'quick_look',
  'glob', 'search_nodes', 'get_node_info', 'get_dependencies', 'find_path',
  'task',
]);

// Staged tool delivery: round 1 sends only the tools the classified task type
// plausibly needs, so the model reasons over a short menu instead of the full
// one. The orchestrator clears the gate the moment the model calls set_mode,
// which returns the full set — so nothing is unreachable. Unknown or
// unclassified task types fall through to the full set.
const TASK_TYPE_TOOLS = new Map([
  ['plan', new Set([
    'set_mode', 'ask_user', 'task',
    'create_plan', 'add_task', 'complete_task', 'get_plan',
  ])],
  ['code-gen', new Set([
    'set_mode', 'ask_user',
    'search_code', 'list_files', 'file_outline', 'quick_look', 'read_file',
    'edit', 'write',
    'create_plan', 'add_task', 'complete_task', 'get_plan',
  ])],
]);

export function computeTools(opts = {}) {
  const {
    excludeExplorationTools = false, excludeReadTool = false,
    mode = 'research', taskType = null,
  } = opts;
  const always = [...SKILL_MANAGEMENT_TOOLS, ...CONTROL_TOOLS, ...NAVIGATION_TOOLS, ...PLAN_TOOLS];
  const conditional = [...GRAPH_TOOLS, ...COMMUNITY_TOOLS, ...LSP_TOOLS, ...MODIFICATION_TOOLS, ...SUB_AGENT_TOOL];
  const available = [];

  for (const tool of always) {
    available.push(tool.toToolSpec());
  }

  const activeSkillNames = REGISTRY.getActiveSkillNames();
  const skillTools = getToolsForActiveSkills(activeSkillNames);
  const combined = [...conditional, ...skillTools];

  const seenNames = new Set(available.map(t => t.function.name));
  for (const tool of combined) {
    if (seenNames.has(tool.name)) continue;
    if (tool.availableWhen()) {
      available.push(tool.toToolSpec());
      seenNames.add(tool.name);
    }
  }

  let result = available;

  const taskSubset = taskType ? TASK_TYPE_TOOLS.get(taskType) : null;
  if (taskSubset) {
    result = result.filter(t => taskSubset.has(t.function.name));
  }

  if (excludeExplorationTools) {
    result = result.filter(t => !EXPLORATION_TOOL_NAMES.has(t.function.name));
  }

  if (excludeReadTool) {
    result = result.filter(t => t.function.name !== 'read_file');
  }

  if (mode === 'edit') {
    result = result.filter(t => EDIT_MODE_TOOL_NAMES.has(t.function.name));
  }

  return result;
}

export function computeSubAgentTools() {
  const subTools = [...NAVIGATION_TOOLS, ...GRAPH_TOOLS, ...LSP_TOOLS, ...COMMUNITY_TOOLS];
  const available = [];
  const seenNames = new Set();
  for (const tool of subTools) {
    if (seenNames.has(tool.name)) continue;
    if (tool.availableWhen()) {
      available.push(tool.toToolSpec());
      seenNames.add(tool.name);
    }
  }
  return available;
}

export function getToolsForActiveSkills(activeSkills) {
  const tools = [];
  for (const skillName of activeSkills) {
    const skillTools = SKILL_TO_TOOLS.get(skillName);
    if (skillTools) {
      tools.push(...skillTools);
    }
  }
  return tools;
}

const SKILL_TO_TOOLS = new Map([
  ['component-graph', GRAPH_TOOLS],
  ['community-architecture', COMMUNITY_TOOLS],
  ['lsp-semantics', LSP_TOOLS],
  ['code-modification', MODIFICATION_TOOLS],
  ['deep-research', SUB_AGENT_TOOL],
]);

export function getToolByName(name) {
  const all = [...CONTROL_TOOLS, ...NAVIGATION_TOOLS, ...GRAPH_TOOLS, ...COMMUNITY_TOOLS, ...LSP_TOOLS, ...MODIFICATION_TOOLS, ...SUB_AGENT_TOOL, ...PLAN_TOOLS, ...SKILL_MANAGEMENT_TOOLS];
  return all.find(t => t.name === name);
}
