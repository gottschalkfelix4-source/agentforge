// Agentforge tools for coding agents (served by the `agentforge-mcp` MCP server inside every workspace).
// The MCP server forwards calls via wsd (`/app-call` → `app.request` notification) to the app server,
// which executes them against the project's tasks, milestones and notes.

import { TASK_COLUMNS } from './pm.js';

export interface AgentToolDef {
  name: string;
  description: string;
  /** JSON schema of the arguments. */
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

const status = {
  type: 'string',
  enum: [...TASK_COLUMNS],
  description: 'Board column / status: backlog, todo, in_progress, review, done',
};
const id = (what: string) => ({ type: 'string', description: `${what} id (as returned by the list tools)` });

export const AGENT_TOOLS: AgentToolDef[] = [
  {
    name: 'project_overview',
    description:
      'Overview of the Agentforge project board: task counts per status, open milestones, pinned notes and — when this chat belongs to a board task — the current task. Call this first to understand planned work.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'current_task',
    description:
      'The board task(s) this chat session works on (started from the task board, or tasks you set to in_progress / gave subtasks in this chat), with description, status and subtasks.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tasks_list',
    description: 'List tasks of the project board. Optional filters by status, milestone or a search term.',
    inputSchema: {
      type: 'object',
      properties: {
        status,
        milestoneId: id('Milestone'),
        query: { type: 'string', description: 'Search in title and description' },
      },
    },
  },
  {
    name: 'task_get',
    description: 'Full details of one task (description, status, subtasks, labels, milestone, linked GitHub issue).',
    inputSchema: { type: 'object', properties: { id: id('Task') }, required: ['id'] },
  },
  {
    name: 'task_create',
    description: 'Create a task on the project board (e.g. to split up work or record follow-ups). Labels are created if missing.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string', description: 'Markdown' },
        status,
        milestoneId: id('Milestone'),
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names' },
        subtasks: { type: 'array', items: { type: 'string' }, description: 'Checklist items (subtasks) to add' },
      },
      required: ['title'],
    },
  },
  {
    name: 'task_update',
    description: 'Update a task: title, description, status, milestone or labels (labels replace the existing ones).',
    inputSchema: {
      type: 'object',
      properties: {
        id: id('Task'),
        title: { type: 'string' },
        description: { type: 'string', description: 'Markdown (replaces the description)' },
        status,
        milestoneId: { type: ['string', 'null'], description: 'Milestone id, or null to remove it' },
        labels: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    },
  },
  {
    name: 'task_set_status',
    description: 'Move a task to another status column (e.g. in_progress when starting, review or done when finished).',
    inputSchema: { type: 'object', properties: { id: id('Task'), status }, required: ['id', 'status'] },
  },
  {
    name: 'subtasks_add',
    description:
      'Add subtasks (checklist items) to a board task, e.g. the steps you plan for it. The task then shows up in the todo bar of this chat, where the user follows your progress.',
    inputSchema: {
      type: 'object',
      properties: { taskId: id('Task'), titles: { type: 'array', items: { type: 'string' }, description: 'One entry per subtask, in order' } },
      required: ['taskId', 'titles'],
    },
  },
  {
    name: 'subtask_update',
    description: 'Tick off a subtask (done: true), reopen it (done: false) or rename it. Update subtasks as soon as a step is finished.',
    inputSchema: {
      type: 'object',
      properties: { id: id('Subtask'), done: { type: 'boolean' }, title: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'milestones_list',
    description: 'List milestones of the roadmap with due dates and progress.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'milestone_create',
    description: 'Create a roadmap milestone.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        dueOn: { type: 'string', description: 'Due date YYYY-MM-DD' },
      },
      required: ['title'],
    },
  },
  {
    name: 'milestone_update',
    description: 'Update a milestone (title, description, due date, open/closed).',
    inputSchema: {
      type: 'object',
      properties: {
        id: id('Milestone'),
        title: { type: 'string' },
        description: { type: 'string' },
        dueOn: { type: ['string', 'null'], description: 'YYYY-MM-DD or null' },
        state: { type: 'string', enum: ['open', 'closed'] },
      },
      required: ['id'],
    },
  },
  {
    name: 'notes_list',
    description: 'List the project notes (id, title, pinned, excerpt).',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Search in title and text' } } },
  },
  {
    name: 'note_get',
    description: 'Read a project note in full.',
    inputSchema: { type: 'object', properties: { id: id('Note') }, required: ['id'] },
  },
  {
    name: 'note_create',
    description: 'Create a project note (Markdown), e.g. for decisions, architecture or findings.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, body: { type: 'string', description: 'Markdown' }, pinned: { type: 'boolean' } },
      required: ['title'],
    },
  },
  {
    name: 'note_update',
    description: 'Update a note: replace title/body, pin it, or append text to the end.',
    inputSchema: {
      type: 'object',
      properties: {
        id: id('Note'),
        title: { type: 'string' },
        body: { type: 'string', description: 'Replaces the whole text' },
        append: { type: 'string', description: 'Appended to the end of the text' },
        pinned: { type: 'boolean' },
      },
      required: ['id'],
    },
  },
];

export const AGENT_TOOL_NAMES = new Set(AGENT_TOOLS.map((t) => t.name));

/** Name of the MCP server entry given to agents. */
export const AGENTFORGE_MCP_NAME = 'agentforge';
