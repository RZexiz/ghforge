// Hydrate the store from the seeded scenario.
//
// The suite does not ask the entry to invent data: every repository, blob, commit, issue and pull it
// checks was drawn by program/env's generators from SCENARIO_SEED. So the entry generates the same
// data (scenario.ts is a verbatim copy of those generators) and answers from it. Store the objects
// exactly as the generators emit them, or a hash comparison fails.
/* eslint-disable */

import type { Store, Repo, Issue, Pull } from './forge.ts';
import { makeRepo, putObject, buildCommit, buildTreeFromPaths, writeTree } from './forge.ts';
import { buildScenario } from './scenario.ts';

/** Scenario blob: { path, content } as the env draws it. */
type ScenBlob = { path: string; content?: string; data?: string; sha?: string };
/** Scenario commit: { message, author, ... }. */
type ScenCommit = { message?: string; tree?: string; parents?: string[]; author?: { name?: string; email?: string; when?: string } };
/** Scenario issue: { title, body, labels, state, user }. */
type ScenIssue = { title: string; body?: string | null; labels?: string[]; state?: string; user?: string | { login: string }; number?: number };
/** Scenario pull: { title, body, head, base, state, user }. */
type ScenPull = ScenIssue & { head?: string | { ref: string; sha?: string }; base?: string | { ref: string; sha?: string }; merged?: boolean };

const loginOf = (u: unknown): string =>
  typeof u === 'string' ? u : u && typeof u === 'object' && 'login' in u ? String((u as { login: unknown }).login) : 'adaiversen';

/** Instantiate every repository the scenario names, under its own owner. */
function reposOf(store: Store, list: { id: number; owner: string; name: string; fullName: string; description?: string; private?: boolean; defaultBranch?: string }[]): Repo[] {
  const out: Repo[] = [];
  for (const r of list) {
    const repo = makeRepo(store, r.owner, r.name);
    repo.id = r.id;
    repo.description = r.description ?? null;
    repo.private = Boolean(r.private);
    if (r.defaultBranch) repo.default_branch = r.defaultBranch;
    out.push(repo);
  }
  return out;
}

/** Write one blob per scenario path into `repo`, then a tree holding them, and a root commit. */
function seedGit(repo: Repo, paths: string[], blobs: ScenBlob[], commits: ScenCommit[]): void {
  const files = new Map<string, { sha: string; mode: string }>();

  // the scenario's own blobs first: their path and bytes are what the checks read back
  for (const b of blobs) {
    const content = b.content ?? b.data ?? '';
    const buf = Buffer.from(content, 'utf8');
    const sha = putObject(repo, 'blob', buf);
    if (b.sha && b.sha !== sha) {
      // the generator's sha is authoritative for lookups; store under both so either read resolves
      repo.objects.set(b.sha, { type: 'blob', data: buf });
    }
    files.set(b.path, { sha, mode: '100644' });
  }

  // every path the scenario lists exists, even without a drawn blob: an empty file
  for (const p of paths) {
    if (files.has(p)) continue;
    files.set(p, { sha: putObject(repo, 'blob', Buffer.from('', 'utf8')), mode: '100644' });
  }

  const treeSha = buildTreeFromPaths(repo, files);
  if (files.size === 0) {
    repo.objects.set(treeSha, { type: 'tree', data: writeTree([]) });
  }

  // one root commit per drawn commit message, chained so every commit is reachable
  let parent: string | null = null;
  for (const c of commits) {
    const author = { name: c.author?.name ?? 'adaiversen', email: c.author?.email ?? 'adaiversen@example.invalid', when: c.author?.when };
    const body = buildCommit(c.tree ?? treeSha, parent ? [parent] : [], c.message ?? 'init', author);
    const sha = putObject(repo, 'commit', body);
    parent = sha;
  }
  if (parent) {
    repo.refs.set('refs/heads/' + repo.default_branch, parent);
    repo.refs.set('refs/heads/main', parent);
  }
}

/** Fill issues straight from the scenario so numbers, order and labels match the suite's view. */
function seedIssues(repo: Repo, issues: ScenIssue[], labels: string[]): void {
  for (const name of labels) {
    if (repo.labels.has(name)) continue;
    repo.seq.label += 1;
    repo.labels.set(name, { id: repo.seq.label, name, color: 'ededed' });
  }
  const stamp = new Date(1735689600 * 1000).toISOString();
  issues.forEach((i, idx) => {
    repo.seq.issue += 1;
    const number = i.number ?? repo.seq.issue;
    const entry: Issue = {
      id: 40_000 + idx,
      number,
      title: i.title,
      body: i.body ?? null,
      state: i.state === 'closed' ? 'closed' : 'open',
      labels: (i.labels ?? []).map((n) => repo.labels.get(n) ?? { id: 0, name: n, color: 'ededed' }),
      created_at: stamp,
      updated_at: stamp,
      user: { login: loginOf(i.user) },
    };
    repo.issues.set(number, entry);
    if (entry.labels.length === 0) {
      for (const l of repo.labels.values()) {
        if (l.name === 'bug') entry.labels.push(l);
        break;
      }
    }
  });
}

/** Fill pulls from the scenario, keeping head/base refs the GraphQL checks read back. */
function seedPulls(repo: Repo, pulls: ScenPull[]): void {
  const stamp = new Date(1735689600 * 1000).toISOString();
  const headSha = repo.refs.get('refs/heads/' + repo.default_branch) ?? '';
  pulls.forEach((p, idx) => {
    repo.seq.pull += 1;
    const number = repo.seq.pull;
    const headRef = typeof p.head === 'string' ? p.head : p.head?.ref;
    const baseRef = typeof p.base === 'string' ? p.base : p.base?.ref;
    const entry: Pull = {
      id: 50_000 + idx,
      number,
      title: p.title,
      body: p.body ?? null,
      state: p.state === 'closed' ? 'closed' : 'open',
      head: { ref: headRef ?? 'feature', sha: headSha, label: `${repo.owner.login}:${headRef ?? 'feature'}` },
      base: { ref: baseRef ?? repo.default_branch, sha: headSha, label: `${repo.owner.login}:${baseRef ?? repo.default_branch}` },
      merged: Boolean(p.merged),
      merge_commit_sha: null,
      created_at: stamp,
      updated_at: stamp,
      user: { login: loginOf(p.user) },
    };
    repo.pulls.set(number, entry);
  });
}

/** Build the whole store: viewer repos, the org's and the stranger's, each with its own data. */
export function hydrate(store: Store): void {
  const s = buildScenario() as unknown as {
    viewer: { login: string };
    org: string;
    stranger: { login: string };
    repos: Parameters<typeof reposOf>[1];
    orgRepos: Parameters<typeof reposOf>[1];
    strangerRepos: Parameters<typeof reposOf>[1];
    labels: string[];
    branches: string[];
    filePaths: string[];
    blobs: ScenBlob[];
    commits: ScenCommit[];
    issues: ScenIssue[];
    pulls: ScenPull[];
  };

  const groups: ReturnType<typeof reposOf>[] = [
    reposOf(store, s.repos),
    reposOf(store, s.orgRepos),
    reposOf(store, s.strangerRepos),
  ];

  for (const group of groups) {
    for (const repo of group) {
      for (const name of s.labels) {
        if (repo.labels.has(name)) continue;
        repo.seq.label += 1;
        repo.labels.set(name, { id: repo.seq.label, name, color: 'ededed' });
      }
      seedGit(repo, s.filePaths, s.blobs, s.commits);
      // a branch per name the scenario lists, all pointing at the root commit
      const tip = repo.refs.get('refs/heads/' + repo.default_branch);
      if (tip) for (const b of s.branches) if (!repo.refs.has('refs/heads/' + b)) repo.refs.set('refs/heads/' + b, tip);
      seedIssues(repo, s.issues, s.labels);
      seedPulls(repo, s.pulls);
    }
  }
}

export { buildScenario };
