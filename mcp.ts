// MCP over Streamable HTTP (JSON-RPC 2.0), revision 2026-07-28.
// Tools act on the same store REST reads back.

import type { Store, Repo } from './forge.ts';
import type { Ctx } from './api.ts';

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

const REVISION = '2026-07-28';
const SUPPORTED = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

type ToolDef = {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
};

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, full_name: { type: 'string' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue',
    description: 'Open an issue on a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, full_name: { type: 'string' } }, required: ['owner', 'repo', 'title'] },
  },
  {
    name: 'list_issues',
    description: 'List a repository’s issues, optionally filtered by state.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' }, full_name: { type: 'string' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a pushed head branch onto a base branch.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' }, body: { type: 'string' }, full_name: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch, squashing its commits.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' }, full_name: { type: 'string' } }, required: ['owner', 'repo', 'pull_number'] },
  },
];

/** The same list, byte for byte, on every call. */
const TOOLS_JSON = JSON.stringify(TOOLS);

let repoFactory: (store: Store, owner: string, name: string) => Repo;
export function bindMcpRepoFactory(fn: (store: Store, owner: string, name: string) => Repo): void {
  repoFactory = fn;
}

let mergeFn: (r: Repo, pullNumber: number, login: string) => { sha: string; ok: boolean };
export function bindMcpMerge(fn: (r: Repo, pullNumber: number, login: string) => { sha: string; ok: boolean }): void {
  mergeFn = fn;
}

function pickFullName(args: Record<string, unknown>): { owner: string; repo: string } {
  const full = typeof args.full_name === 'string' ? args.full_name : '';
  if (full.includes('/')) {
    const [o, r] = full.split('/');
    return { owner: o, repo: r };
  }
  return { owner: String(args.owner ?? ''), repo: String(args.repo ?? '') };
}

/** Run one tool and return the MCP result object. */
function callTool(ctx: Ctx, name: string, args: Record<string, unknown>): { result?: unknown; error?: { code: number; message: string }; isError?: boolean } {
  const { store, login } = ctx;
  const base = name.includes('__') ? name.slice(name.lastIndexOf('__') + 2) : name;
  const tool = base.toLowerCase();

  if (tool === 'create_repo') {
    if (typeof args.name !== 'string' || args.name === '') {
      return { isError: true, result: { content: [{ type: 'text', text: 'name is required' }] } };
    }
    const r = repoFactory(store, login, args.name);
    if (typeof args.description === 'string') r.description = args.description;
    return { result: { content: [{ type: 'text', text: JSON.stringify(repoJson(r)) }], structuredContent: repoJson(r) } };
  }

  const { owner, repo } = pickFullName(args);
  const r = store.repos.get(`${owner}/${repo}`);

  if (tool === 'get_repo') {
    if (!r) return { isError: true, result: { content: [{ type: 'text', text: `repository ${owner}/${repo} not found` }] } };
    return { result: { content: [{ type: 'text', text: JSON.stringify(repoJson(r)) }], structuredContent: repoJson(r) } };
  }

  if (tool === 'create_issue') {
    if (!r) return { isError: true, result: { content: [{ type: 'text', text: `repository ${owner}/${repo} not found` }] } };
    if (typeof args.title !== 'string' || args.title === '') {
      return { isError: true, result: { content: [{ type: 'text', text: 'title is required' }] } };
    }
    r.seq.issue += 1;
    const issue = {
      id: 9000 + r.seq.issue,
      number: r.seq.issue,
      title: args.title,
      body: typeof args.body === 'string' ? args.body : null,
      state: 'open' as const,
      labels: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      user: { login },
    };
    r.issues.set(issue.number, issue);
    const view = { id: issue.id, number: issue.number, title: issue.title, state: issue.state, body: issue.body };
    return { result: { content: [{ type: 'text', text: JSON.stringify(view) }], structuredContent: view } };
  }

  if (tool === 'list_issues') {
    if (!r) return { isError: true, result: { content: [{ type: 'text', text: `repository ${owner}/${repo} not found` }] } };
    const state = typeof args.state === 'string' ? args.state : 'open';
    let list = [...r.issues.values()];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    const view = list.map((i) => ({ id: i.id, number: i.number, title: i.title, state: i.state, body: i.body }));
    return { result: { content: [{ type: 'text', text: JSON.stringify(view) }], structuredContent: { issues: view } } };
  }

  if (tool === 'create_pull_request') {
    if (!r) return { isError: true, result: { content: [{ type: 'text', text: `repository ${owner}/${repo} not found` }] } };
    const head = String(args.head ?? '');
    const baseRef = String(args.base ?? '');
    const headSha = r.refs.get(`refs/heads/${head}`);
    const baseSha = r.refs.get(`refs/heads/${baseRef}`);
    if (!headSha || !baseSha) {
      return { isError: true, result: { content: [{ type: 'text', text: `ref not found: ${!headSha ? head : baseRef}` }] } };
    }
    r.seq.pull += 1;
    const pull = {
      id: 7000 + r.seq.pull,
      number: r.seq.pull,
      title: String(args.title ?? ''),
      body: typeof args.body === 'string' ? args.body : null,
      state: 'open' as const,
      head: { ref: head, sha: headSha, label: `${r.owner.login}:${head}` },
      base: { ref: baseRef, sha: baseSha, label: `${r.owner.login}:${baseRef}` },
      merged: false,
      merge_commit_sha: null as string | null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      user: { login },
    };
    r.pulls.set(pull.number, pull);
    const view = { id: pull.id, number: pull.number, title: pull.title, state: pull.state, head: pull.head.ref, base: pull.base.ref };
    return { result: { content: [{ type: 'text', text: JSON.stringify(view) }], structuredContent: view } };
  }

  if (tool === 'merge_pull_request') {
    if (!r) return { isError: true, result: { content: [{ type: 'text', text: `repository ${owner}/${repo} not found` }] } };
    const num = Number(args.pull_number ?? args.pullNumber ?? args.number ?? 0);
    const res = mergeFn(r, num, login);
    if (!res.ok) return { isError: true, result: { content: [{ type: 'text', text: 'pull request is not mergeable' }] } };
    const view = { sha: res.sha, merged: true, message: 'Pull Request successfully merged' };
    return { result: { content: [{ type: 'text', text: JSON.stringify(view) }], structuredContent: view } };
  }

  return { error: { code: -32601, message: `Unknown tool: ${name}` } };
}

function repoJson(r: Repo): Record<string, unknown> {
  return { id: r.id, name: r.name, full_name: r.full_name, description: r.description, default_branch: r.default_branch, owner: { login: r.owner.login } };
}

/** Handle one JSON-RPC message; returns the reply object, or null for notifications. */
export function mcpHandle(ctx: Ctx, msg: Rpc): Record<string, unknown> | null {
  const id = msg.id ?? null;
  const method = msg.method ?? '';
  const params = (msg.params ?? {}) as Record<string, unknown>;
  const ok = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string): Record<string, unknown> => ({ jsonrpc: '2.0', id, error: { code, message } });

  if (method === 'initialize') {
    return ok({
      protocolVersion: REVISION,
      capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} },
      serverInfo: { name: 'ghforge', version: '1.0.0' },
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
  if (method === 'server/discover') {
    return ok({ supportedVersions: SUPPORTED, serverInfo: { name: 'ghforge', version: '1.0.0' }, capabilities: { tools: {} } });
  }
  if (method === 'ping') return ok({});
  if (method === 'tools/list') {
    return ok({ tools: JSON.parse(TOOLS_JSON) });
  }
  if (method === 'tools/call') {
    const name = String(params.name ?? '');
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (!ctx.token) return fail(-32600, 'unauthorised');
    const res = callTool(ctx, name, args);
    if (res.error) return fail(res.error.code, res.error.message);
    if (res.isError) return ok({ isError: true, content: (res.result as { content: unknown[] }).content });
    return ok({ ...(res.result as Record<string, unknown>), isError: false });
  }
  if (method === 'resources/list') return ok({ resources: [] });
  if (method === 'prompts/list') return ok({ prompts: [] });

  return fail(-32601, `Method not found: ${method}`);
}
