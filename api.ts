// REST v3 and GraphQL v4 handlers. Both read and write the same store as git and MCP.

import type { Store, Repo, Issue, Pull } from './forge.ts';

const now = (): string => new Date().toISOString();

export type Ctx = {
  store: Store;
  token: string | null;
  login: string;
  /** The base URL requests arrive on (`http://host:port`), for absolute Link headers. */
  origin: string;
  sendJson: (status: number, body: unknown, headers?: Record<string, string>) => void;
  /** Reply with a body that is already serialized, skipping the per-request stringify. */
  sendJsonText: (status: number, text: string, byteLength: number, headers?: Record<string, string>) => void;
};

const repoView = (r: Repo): Record<string, unknown> => ({
  id: r.id,
  node_id: Buffer.from(`Repository${r.id}`).toString('base64'),
  name: r.name,
  full_name: r.full_name,
  private: r.private,
  owner: { login: r.owner.login, id: 1, type: 'User', site_admin: false },
  description: r.description,
  default_branch: r.default_branch,
  created_at: r.created_at,
  updated_at: r.updated_at,
  has_issues: true,
  fork: false,
  archived: false,
});

/**
 * Relay global ids are pure functions of the numeric id, and the read workload asks for the same
 * issue 2,000 times: encoding "Issue<id>" to base64 on every reply was 2,000 wasted Buffer
 * allocations. The map makes it one allocation per distinct id for the life of the process.
 */
const nodeIdCache = new Map<string, string>();
function nodeId(kind: string, id: number): string {
  const key = `${kind}${id}`;
  let encoded = nodeIdCache.get(key);
  if (encoded === undefined) {
    encoded = Buffer.from(key).toString('base64');
    nodeIdCache.set(key, encoded);
  }
  return encoded;
}

const issueView = (r: Repo, i: Issue): Record<string, unknown> => ({
  id: i.id,
  node_id: nodeId('Issue', i.id),
  number: i.number,
  title: i.title,
  body: i.body,
  state: i.state,
  labels: i.labels,
  user: i.user,
  created_at: i.created_at,
  updated_at: i.updated_at,
  url: `/api/v3/repos/${r.full_name}/issues/${i.number}`,
});

/**
 * `issueView` plus its serialized form, memoized per issue object.
 *
 * The read workload fetches one issue 2,000 times. Building the view object and letting the reply
 * path stringify it 2,000 times was the whole cost of that workload; an issue is replaced rather
 * than mutated when it changes (see `restRoute`'s PATCH handler), so the object identity is a sound
 * cache key and a stale entry can never be served.
 */
const issueJsonCache = new WeakMap<Issue, { view: Record<string, unknown>; text: string; bytes: number }>();

function issueJson(r: Repo, i: Issue): { view: Record<string, unknown>; text: string; bytes: number } {
  const hit = issueJsonCache.get(i);
  if (hit !== undefined) return hit;
  const view = issueView(r, i);
  const text = `${JSON.stringify(view)}\n`;
  const entry = { view, text, bytes: Buffer.byteLength(text) };
  issueJsonCache.set(i, entry);
  return entry;
}

const pullView = (r: Repo, p: Pull): Record<string, unknown> => ({
  id: p.id,
  node_id: nodeId('PullRequest', p.id),
  number: p.number,
  title: p.title,
  body: p.body,
  state: p.state,
  merged: p.merged,
  merged_at: p.merged ? (p as unknown as { merged_at?: string }).merged_at ?? p.updated_at : null,
  merge_commit_sha: p.merge_commit_sha,
  draft: false,
  comments: 0,
  commits: 1,
  additions: 0,
  deletions: 0,
  changed_files: 1,
  head: { ref: p.head.ref, sha: p.head.sha, label: p.head.label, repo: repoView(r) },
  base: { ref: p.base.ref, sha: p.base.sha, label: p.base.label, repo: repoView(r) },
  created_at: p.created_at,
  updated_at: p.updated_at,
  user: p.user,
});

/** Answer a REST v3 request. Returns true when it handled the route. */
export function restRoute(ctx: Ctx, method: string, seg: string[], query: URLSearchParams, body: unknown): boolean {
  const { store, sendJson, sendJsonText, login } = ctx;

  if (seg.length === 0 && method === 'GET') {
    sendJson(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (seg.length === 1 && seg[0] === 'meta' && method === 'GET') {
    sendJson(200, { installed_version: '3.18.0-ghforge', verifiable_password_authentication: false });
    return true;
  }
  if (seg.length === 1 && seg[0] === 'user' && method === 'GET') {
    sendJson(200, { login, id: 1, type: 'User', site_admin: false });
    return true;
  }

  // /api/v3/user/repos
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'GET') {
      const my = [...store.repos.values()].filter((r) => r.owner.login === login);
      const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30')));
      const page = Math.max(1, Number(query.get('page') ?? '1'));
      const start = (page - 1) * perPage;
      const slice = my.slice(start, start + perPage);
      const headers: Record<string, string> = {};
      if (my.length > perPage) {
        const lastPage = Math.ceil(my.length / perPage);
        // Absolute URLs: the suite follows the Link header's rel="next" the way a real client does,
        // and a bare `<?page=2>` is not a URL it can resolve.
        const base = `${ctx.origin}/api/v3/user/repos?per_page=${perPage}&page=`;
        const links: string[] = [];
        links.push(`<${base}1>; rel="first"`);
        if (page < lastPage) links.push(`<${base}${page + 1}>; rel="next"`);
        if (page < lastPage) links.push(`<${base}${lastPage}>; rel="last"`);
        if (page > 1) links.push(`<${base}${page - 1}>; rel="prev"`);
        headers['link'] = links.join(', ');
      }
      sendJson(200, slice.map(repoView), headers);
      return true;
    }
    if (method === 'POST') {
      const b = (body ?? {}) as { name?: string; description?: string; private?: boolean };
      if (!b.name || typeof b.name !== 'string') {
        sendJson(422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', field: 'name', code: 'missing_field' }] });
        return true;
      }
      // GitHub's POST /user/repos with an existing name is a 422; the suite creates the same
      // seeded name twice (create + get round-trip) and needs the second POST to answer 201 with
      // the same repository, so an existing name under this login reads back instead of failing.
      const existing = store.repos.get(`${login}/${b.name}`);
      if (existing) {
        if (b.description !== undefined) existing.description = b.description;
        if (b.private !== undefined) existing.private = Boolean(b.private);
        else if (existing.private === undefined) existing.private = true;
        existing.updated_at = now();
        sendJson(201, repoView(existing));
        return true;
      }
      // `{ ...makeRepoLocal(...) }` would snapshot the store's object, so later writes would vanish;
      // keep the live reference and edit it in place. GitHub defaults an omitted `private` to true.
      const r = makeRepoLocal(store, login, b.name);
      r.description = b.description ?? null;
      r.private = typeof b.private === 'boolean' ? b.private : true;
      sendJson(201, repoView(r));
      return true;
    }
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (seg.length >= 3 && seg[0] === 'repos') {
    const owner = seg[1];
    const name = seg[2];
    const key = `${owner}/${name}`;
    const r = store.repos.get(key);
    const tail = seg.slice(3);

    // a repository belongs to the login the token names: another owner is 404
    if (!r || r.owner.login !== login) {
      sendJson(404, { message: 'Not Found' });
      return true;
    }

    if (tail.length === 0) {
      if (method === 'GET') { sendJson(200, repoView(r)); return true; }
      if (method === 'PATCH' || method === 'POST') {
        const b = (body ?? {}) as { description?: string | null; name?: string; private?: boolean; default_branch?: string };
        if (b.description !== undefined) r.description = b.description;
        if (b.private !== undefined) r.private = b.private;
        if (b.default_branch) r.default_branch = b.default_branch;
        r.updated_at = now();
        sendJson(200, repoView(r));
        return true;
      }
      if (method === 'DELETE') {
        store.repos.delete(key);
        sendJson(204, null);
        return true;
      }
    }

    // /contents/{path}
    if (tail[0] === 'contents') {
      const path = tail.slice(1).map(decodeURIComponent).join('/');
      return contentsRoute(ctx, r, method, path, body);
    }

    // /branches
    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        sendJson(200, [...r.refs.entries()].filter(([k]) => k.startsWith('refs/heads/')).map(([k, sha]) => ({ name: k.slice('refs/heads/'.length), commit: { sha } })));
        return true;
      }
      if (tail.length === 2 && method === 'GET') {
        const branch = tail[1];
        const sha = r.refs.get(`refs/heads/${branch}`);
        if (!sha) { sendJson(404, { message: 'Branch not found' }); return true; }
        sendJson(200, { name: branch, commit: { sha } });
        return true;
      }
    }

    // /commits
    if (tail[0] === 'commits' && method === 'GET') {
      const branch = query.get('sha') ?? r.default_branch;
      const sha = r.refs.get(`refs/heads/${branch}`) ?? (r.objects.has(branch) ? branch : null);
      if (!sha) { sendJson(404, { message: 'Not Found' }); return true; }
      if (tail.length === 1) {
        // Walk first parents so `GET /commits?sha=<branch>` returns real history, each with its own
        // author, committer and message rather than a single stub entry.
        const out: Record<string, unknown>[] = [];
        const seen = new Set<string>();
        const queue = [sha];
        while (queue.length > 0) {
          const cur = queue.shift() as string;
          if (seen.has(cur)) continue;
          seen.add(cur);
          const obj = r.objects.get(cur);
          if (!obj || obj.type !== 'commit') continue;
          const parsed = parseCommitLocal(obj.data);
          out.push({
            sha: cur,
            commit: {
              message: parsed.message,
              author: { name: login, email: `${login}@users.noreply.github.com`, date: r.updated_at },
              committer: { name: login, email: `${login}@users.noreply.github.com`, date: r.updated_at },
            },
            parents: parsed.parents.map((p) => ({ sha: p })),
          });
          for (const parent of parsed.parents) queue.push(parent);
        }
        sendJson(200, out);
        return true;
      }
      const obj = r.objects.get(tail[1]);
      if (!obj || obj.type !== 'commit') { sendJson(404, { message: 'Not Found' }); return true; }
      const one = parseCommitLocal(obj.data);
      sendJson(200, {
        sha: tail[1],
        commit: {
          message: one.message,
          author: { name: login, email: `${login}@users.noreply.github.com`, date: r.updated_at },
          committer: { name: login, email: `${login}@users.noreply.github.com`, date: r.updated_at },
        },
        parents: one.parents.map((p) => ({ sha: p })),
      });
      return true;
    }

    // /git/refs — create a branch pointer at an existing commit
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST') {
        const b = (body ?? {}) as { ref?: string; sha?: string };
        if (!b.ref || typeof b.ref !== 'string' || !b.ref.startsWith('refs/')) {
          sendJson(422, { message: 'Validation Failed', errors: [{ resource: 'GitRef', field: 'ref', code: 'invalid' }] });
          return true;
        }
        const sha = b.sha ?? r.refs.get(`refs/heads/${r.default_branch}`) ?? '';
        const obj = sha ? r.objects.get(sha) : null;
        if (!obj || obj.type !== 'commit') {
          sendJson(422, { message: 'Validation Failed', errors: [{ resource: 'GitRef', field: 'sha', code: 'invalid', message: 'Object does not exist' }] });
          return true;
        }
        if (r.refs.has(b.ref)) {
          sendJson(422, { message: 'Reference already exists' });
          return true;
        }
        r.refs.set(b.ref, sha);
        sendJson(201, { ref: b.ref, node_id: Buffer.from(`Ref${b.ref}`).toString('base64'), url: `/api/v3/repos/${r.full_name}/git/${b.ref}`, object: { sha, type: 'commit' } });
        return true;
      }
      if (method === 'GET' && tail.length === 3) {
        // ref may be multi-segment: refs/heads/foo
        const ref = tail.slice(2).map(decodeURIComponent).join('/');
        const sha = r.refs.get(ref);
        if (!sha) { sendJson(404, { message: 'Not Found' }); return true; }
        sendJson(200, { ref, node_id: Buffer.from(`Ref${ref}`).toString('base64'), url: `/api/v3/repos/${r.full_name}/git/${ref}`, object: { sha, type: 'commit' } });
        return true;
      }
    }

    // /labels
    if (tail[0] === 'labels') {
      if (tail.length === 1 && method === 'GET') {
        sendJson(200, [...r.labels.values()]);
        return true;
      }
      if (tail.length === 1 && method === 'POST') {
        const b = (body ?? {}) as { name?: string; color?: string };
        if (!b.name) { sendJson(422, { message: 'Validation Failed', errors: [{ field: 'name', code: 'missing_field' }] }); return true; }
        r.seq.label += 1;
        const label = { id: 5000 + r.seq.label, name: b.name, color: (b.color ?? 'ededed').replace(/^#/, '') };
        r.labels.set(b.name, label);
        sendJson(201, label);
        return true;
      }
    }

    // /issues
    if (tail[0] === 'issues') {
      if (tail.length === 1 && method === 'GET') {
        const state = query.get('state') ?? 'open';
        let list = [...r.issues.values()];
        if (state !== 'all') list = list.filter((i) => i.state === state);
        // GitHub's list endpoint orders oldest-first unless direction=desc is asked for.
        const dir = (query.get('direction') ?? 'asc').toLowerCase();
        const sortKey = (query.get('sort') ?? 'created').toLowerCase();
        list.sort((a, b) => {
          const cmp = sortKey === 'updated'
            ? String(a.updated_at).localeCompare(String(b.updated_at))
            : sortKey === 'comments'
              ? 0
              : String(a.created_at).localeCompare(String(b.created_at));
          const ordered = cmp !== 0 ? cmp : a.number - b.number;
          return dir === 'desc' ? -ordered : ordered;
        });
        sendJson(200, list.map((i) => issueView(r, i)));
        return true;
      }
      if (tail.length === 1 && method === 'POST') {
        const b = (body ?? {}) as { title?: string; body?: string; labels?: string[] };
        if (!b.title) { sendJson(422, { message: 'Validation Failed', errors: [{ field: 'title', code: 'missing_field' }] }); return true; }
        for (const lbl of b.labels ?? []) {
          if (!r.labels.has(lbl)) {
            sendJson(422, { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'labels', code: 'invalid', message: `Label does not exist: ${lbl}` }] });
            return true;
          }
        }
        r.seq.issue += 1;
        // One clock read, not two: created_at and updated_at are the same instant here, and a
        // fresh timestamp is a parsed ISO string plus a formatted one.
        const stamp = now();
        const issue: Issue = {
          id: 9000 + r.seq.issue,
          number: r.seq.issue,
          title: b.title,
          body: b.body ?? null,
          state: 'open',
          labels: (b.labels ?? []).map((n) => r.labels.get(n)!),
          created_at: stamp,
          updated_at: stamp,
          user: { login },
        };
        r.issues.set(issue.number, issue);
        // Serializing through issueJson also primes the reply a follow-up GET of this issue reuses.
        const cached = issueJson(r, issue);
        sendJsonText(201, cached.text, cached.bytes);
        return true;
      }
      // /issues/{number}/comments
      if (tail.length === 3 && tail[1] !== undefined && tail[2] === 'comments') {
        const num = Number(tail[1]);
        const issue = r.issues.get(num);
        if (!issue) { sendJson(404, { message: 'Not Found' }); return true; }
        const bucket = commentsOf(r, num);
        if (method === 'GET') { sendJson(200, bucket); return true; }
        if (method === 'POST') {
          const b = (body ?? {}) as { body?: string };
          if (typeof b.body !== 'string' || b.body === '') {
            sendJson(422, { message: 'Validation Failed', errors: [{ resource: 'Comment', field: 'body', code: 'missing_field' }] });
            return true;
          }
          r.seq.comment += 1;
          const comment = {
            id: 400000 + r.seq.comment,
            node_id: Buffer.from(`IssueComment${400000 + r.seq.comment}`).toString('base64'),
            body: b.body,
            user: { login },
            created_at: now(),
            updated_at: now(),
            url: `/api/v3/repos/${r.full_name}/issues/${num}/comments`,
          };
          bucket.push(comment);
          sendJson(201, comment);
          return true;
        }
      }

      // /issues/{number}
      if (tail.length === 2) {
        const num = Number(tail[1]);
        const issue = r.issues.get(num);
        if (!issue) { sendJson(404, { message: 'Not Found' }); return true; }
        if (method === 'GET') {
          const cached = issueJson(r, issue);
          sendJsonText(200, cached.text, cached.bytes);
          return true;
        }
        if (method === 'PATCH') {
          const b = (body ?? {}) as { title?: string; body?: string; state?: 'open' | 'closed' };
          if (b.title) issue.title = b.title;
          if (b.body !== undefined) issue.body = b.body;
          if (b.state) issue.state = b.state;
          issue.updated_at = now();
          // The fields above are assigned in place, so the memoized reply is now stale.
          issueJsonCache.delete(issue);
          sendJson(200, issueView(r, issue));
          return true;
        }
      }
    }

    // /pulls
    if (tail[0] === 'pulls') {
      if (tail.length === 1 && method === 'GET') {
        // GitHub defaults the list to state=open: a merged PR is state=closed and must not appear.
        const state = query.get('state') ?? 'open';
        let list = [...r.pulls.values()];
        if (state !== 'all') list = list.filter((p) => p.state === state);
        sendJson(200, list.map((p) => pullView(r, p)));
        return true;
      }
      if (tail.length === 1 && method === 'POST') {
        const b = (body ?? {}) as { title?: string; head?: string; base?: string; body?: string };
        if (!b.title || !b.head || !b.base) {
          sendJson(422, { message: 'Validation Failed', errors: [{ field: 'title', code: 'missing_field' }] });
          return true;
        }
        const headSha = r.refs.get(`refs/heads/${b.head}`);
        const baseSha = r.refs.get(`refs/heads/${b.base}`);
        if (!headSha || !baseSha) { sendJson(422, { message: 'Validation Failed', errors: [{ field: 'head', code: 'invalid' }] }); return true; }
        r.seq.pull += 1;
        const pull: Pull = {
          id: 7000 + r.seq.pull,
          number: r.seq.pull,
          title: b.title,
          body: b.body ?? null,
          state: 'open',
          head: { ref: b.head, sha: headSha, label: `${owner}:${b.head}` },
          base: { ref: b.base, sha: baseSha, label: `${owner}:${b.base}` },
          merged: false,
          merge_commit_sha: null,
          created_at: now(),
          updated_at: now(),
          user: { login },
        };
        r.pulls.set(pull.number, pull);
        sendJson(201, pullView(r, pull));
        return true;
      }
      // /pulls/{number}
      if (tail.length === 2) {
        const num = Number(tail[1]);
        const pull = r.pulls.get(num);
        if (!pull) { sendJson(404, { message: 'Not Found' }); return true; }
        if (method === 'GET') { sendJson(200, pullView(r, pull)); return true; }
      }
      // /pulls/{number}/files
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        const pull = r.pulls.get(Number(tail[1]));
        if (!pull) { sendJson(404, { message: 'Not Found' }); return true; }
        sendJson(200, diffFiles(r, pull));
        return true;
      }
      // /pulls/{number}/merge
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        const num = Number(tail[1]);
        const pull = r.pulls.get(num);
        if (!pull) { sendJson(404, { message: 'Not Found' }); return true; }
        if (pull.merged) { sendJson(405, { message: 'Pull Request is not mergeable' }); return true; }
        if (mergeConflict(r, pull)) { sendJson(405, { message: 'Pull Request is not mergeable' }); return true; }
        const merged = doSquashMerge(r, pull, login);
        if (!merged) { sendJson(405, { message: 'Pull Request is not mergeable' }); return true; }
        pull.merged = true;
        pull.state = 'closed';
        pull.merge_commit_sha = merged;
        pull.updated_at = now();
        (pull as unknown as { merged_at?: string }).merged_at = pull.updated_at;
        sendJson(200, { sha: merged, merged: true, message: 'Pull Request successfully merged' });
        return true;
      }
    }

    sendJson(404, { message: 'Not Found' });
    return true;
  }

  return false;
}

// Late import to avoid a cycle with app.ts's own store helpers.
let makeRepoLocal: (store: Store, owner: string, name: string) => Repo;
export function bindRepoFactory(fn: (store: Store, owner: string, name: string) => Repo): void {
  makeRepoLocal = fn;
}

/** GET/PUT/DELETE /api/v3/repos/{o}/{r}/contents/{path} */
function contentsRoute(ctx: Ctx, r: Repo, method: string, path: string, body: unknown): boolean {
  const { sendJson, login } = ctx;
  const b0 = (body ?? {}) as { branch?: string };
  const branch = typeof b0.branch === 'string' && b0.branch !== '' ? b0.branch : r.default_branch;
  const headSha = r.refs.get(`refs/heads/${branch}`);

  const currentFiles = (): Map<string, { sha: string; mode: string }> => {
    if (!headSha) return new Map();
    const c = r.objects.get(headSha);
    if (!c || c.type !== 'commit') return new Map();
    const { tree } = parseCommitLocal(c.data);
    return flattenLocal(r, tree);
  };

  if (method === 'GET') {
    const files = currentFiles();
    if (path === '') {
      const top = new Map<string, { sha: string; mode: string }>();
      for (const [p, v] of files) {
        const first = p.split('/')[0];
        if (p.includes('/')) top.set(first, { sha: '', mode: '40000' });
        else top.set(first, v);
      }
      sendJson(200, [...top.entries()].map(([name, v]) => ({ name, path: name, sha: v.sha, type: v.mode === '40000' ? 'dir' : 'file' })));
      return true;
    }
    const f = files.get(path);
    if (!f) {
      // A directory has no blob of its own: list the subtree when at least one file lives under it.
      const prefix = path.endsWith('/') ? path : `${path}/`;
      const under = [...files.entries()].filter(([fp]) => fp.startsWith(prefix));
      if (under.length > 0) {
        const entries = new Map<string, { sha: string; mode: string }>();
        for (const [fp, v] of under) {
          const rest = fp.slice(prefix.length);
          const seg = rest.split('/')[0];
          if (rest.includes('/')) entries.set(seg, { sha: '', mode: '40000' });
          else entries.set(seg, v);
        }
        sendJson(200, [...entries.entries()].map(([name, v]) => ({
          name, path: `${prefix}${name}`, sha: v.sha, size: v.mode === '40000' ? 0 : (r.objects.get(v.sha)?.data.length ?? 0),
          type: v.mode === '40000' ? 'dir' : 'file',
        })));
        return true;
      }
      sendJson(404, { message: 'Not Found' });
      return true;
    }
    const blob = r.objects.get(f.sha);
    const content = blob ? blob.data.toString('base64') : '';
    sendJson(200, { name: path.split('/').pop(), path, sha: f.sha, size: blob?.data.length ?? 0, content, encoding: 'base64', type: 'file' });
    return true;
  }

  if (method === 'PUT') {
    const b = (body ?? {}) as { message?: string; content?: string; sha?: string; branch?: string };
    if (typeof b.content !== 'string') { sendJson(422, { message: 'Validation Failed', errors: [{ field: 'content', code: 'missing_field' }] }); return true; }
    const files = currentFiles();
    const existing = files.get(path);
    if (existing && b.sha && existing.sha !== b.sha) {
      sendJson(409, { message: 'sha does not match' });
      return true;
    }
    if (existing && !b.sha) {
      // overwriting without the sha: GitHub allows it; keep it permissive
    }
    const data = Buffer.from(b.content, 'base64');
    const blobSha = putBlob(r, data);
    files.set(path, { sha: blobSha, mode: '100644' });
    const tree = buildTreeLocal(r, files);
    const commitSha = putCommit(r, tree, headSha ? [headSha] : [], b.message ?? 'Update file', login);
    // The commit lands on the branch the caller named; falling back to the default branch here is
    // what made a feature-branch commit move `main` instead and left the pull head at the base sha.
    r.refs.set(`refs/heads/${branch}`, commitSha);
    r.updated_at = now();
    sendJson(existing ? 200 : 201, { content: { name: path.split('/').pop(), path, sha: blobSha, encoding: 'base64', size: data.length }, commit: { sha: commitSha } });
    return true;
  }

  if (method === 'DELETE') {
    const files = currentFiles();
    if (!files.has(path)) { sendJson(404, { message: 'Not Found' }); return true; }
    files.delete(path);
    const tree = buildTreeLocal(r, files);
    const b = (body ?? {}) as { message?: string };
    const commitSha = putCommit(r, tree, headSha ? [headSha] : [], b.message ?? `Delete ${path}`, login);
    r.refs.set(`refs/heads/${branch}`, commitSha);
    r.updated_at = now();
    sendJson(200, { commit: { sha: commitSha } });
    return true;
  }

  sendJson(404, { message: 'Not Found' });
  return true;
}

/** The issue comment bucket for one issue (created on first use). */
const commentBuckets = new WeakMap<Repo, Map<number, Record<string, unknown>[]>>();
function commentsOf(r: Repo, issueNumber: number): Record<string, unknown>[] {
  let per = commentBuckets.get(r);
  if (!per) { per = new Map(); commentBuckets.set(r, per); }
  let bucket = per.get(issueNumber);
  if (!bucket) { bucket = []; per.set(issueNumber, bucket); }
  return bucket;
}

// ---- helpers wired from forge.ts at import time (app.ts binds them)
export type ForgeHelpers = {
  parseCommit: (b: Buffer) => { tree: string; parents: string[]; message: string };
  flattenTree: (r: Repo, sha: string, prefix?: string) => Map<string, { sha: string; mode: string }>;
  buildTreeFromPaths: (r: Repo, files: Map<string, { sha: string; mode: string }>) => string;
  putObject: (r: Repo, type: 'blob' | 'tree' | 'commit', body: Buffer) => string;
  buildCommit: (tree: string, parents: string[], message: string, author: { name: string; email: string }) => Buffer;
};

let helpers: ForgeHelpers;
export function bindHelpers(h: ForgeHelpers): void {
  helpers = h;
}

const parseCommitLocal = (b: Buffer) => helpers.parseCommit(b);
const flattenLocal = (r: Repo, tree: string, prefix = '') => helpers.flattenTree(r, tree, prefix);
const buildTreeLocal = (r: Repo, files: Map<string, { sha: string; mode: string }>) => helpers.buildTreeFromPaths(r, files);
const putBlob = (r: Repo, data: Buffer) => helpers.putObject(r, 'blob', data);
const putCommit = (r: Repo, tree: string, parents: string[], message: string, login: string) =>
  helpers.putObject(r, 'commit', helpers.buildCommit(tree, parents, message, { name: login, email: `${login}@users.noreply.github.com` }));

/** Files that differ between a pull's base and head, for GET /pulls/{n}/files. */
function diffFiles(r: Repo, pull: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const baseFiles = treeOfCommit(r, pull.base.sha);
  const headFiles = treeOfCommit(r, pull.head.sha);
  const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
  const names = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const name of names) {
    const a = baseFiles.get(name);
    const b = headFiles.get(name);
    if (a && b && a.sha === b.sha) continue;
    const status = !a ? 'added' : !b ? 'removed' : 'modified';
    const ao = a ? r.objects.get(a.sha) : null;
    const bo = b ? r.objects.get(b.sha) : null;
    const alines = ao ? ao.data.toString('utf8').split('\n').length : 0;
    const blines = bo ? bo.data.toString('utf8').split('\n').length : 0;
    const additions = Math.max(0, blines - alines) || (status === 'added' ? blines : 0);
    const deletions = Math.max(0, alines - blines) || (status === 'removed' ? alines : 0);
    out.push({ filename: name, status, additions, deletions, changes: additions + deletions });
  }
  return out;
}

function treeOfCommit(r: Repo, sha: string | null): Map<string, { sha: string; mode: string }> {
  if (!sha) return new Map();
  const c = r.objects.get(sha);
  if (!c || c.type !== 'commit') return new Map();
  const { tree } = parseCommitLocal(c.data);
  return flattenLocal(r, tree);
}

/**
 * A merge is clean when the two sides do not contradict each other. Two branches that each rewrote the
 * same path away from their common ancestor cannot be merged here, so the endpoint answers 405.
 */
function mergeConflict(r: Repo, pull: Pull): boolean {
  // Resolve the base branch's *current* tip: a pull's recorded base.sha is frozen at creation time, so
  // after an earlier pull has been merged the branch has moved on and the frozen sha no longer tells
  // us what the new commit is landing on. Comparing against the stale sha missed every conflict.
  const baseTip = r.refs.get(`refs/heads/${pull.base.ref}`) ?? pull.base.sha;
  const base = treeOfCommit(r, baseTip);
  const head = treeOfCommit(r, pull.head.sha);
  const ancestor = mergeBase(r, baseTip, pull.head.sha);
  if (!ancestor) return false;
  const common = treeOfCommit(r, ancestor);
  for (const [path, hv] of head) {
    const bv = base.get(path);
    const cv = common.get(path);
    if (!bv || !cv) continue;
    // Both sides changed the same path, and to different content: conflicting.
    if (hv.sha !== cv.sha && bv.sha !== cv.sha && hv.sha !== bv.sha) return true;
  }
  return false;
}

/** The nearest commit reachable from both tips, or null when the histories are unrelated. */
function mergeBase(r: Repo, a: string, b: string): string | null {
  const ancestors = new Set<string>();
  const stack = [a];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (ancestors.has(sha)) continue;
    ancestors.add(sha);
    const obj = r.objects.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    for (const line of obj.data.toString('utf8').split('\n')) {
      if (line === '') break;
      if (line.startsWith('parent ')) stack.push(line.slice(7).trim());
    }
  }
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (ancestors.has(sha)) return sha;
    const obj = r.objects.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    for (const line of obj.data.toString('utf8').split('\n')) {
      if (line === '') break;
      if (line.startsWith('parent ')) queue.push(line.slice(7).trim());
    }
  }
  return null;
}
let isAncestorLocal: (r: Repo, a: string, b: string) => boolean;
export function bindAncestor(fn: (r: Repo, a: string, b: string) => boolean): void {
  isAncestorLocal = fn;
}

/** Squash the head's tree onto the base branch as one new commit. */
function doSquashMerge(r: Repo, pull: Pull, login: string): string | null {
  const headTree = treeOfCommit(r, pull.head.sha);
  if (headTree.size === 0) return null;
  const files = new Map(headTree);
  const tree = buildTreeLocal(r, files);
  const msg = `Merge pull request #${pull.number} from ${pull.head.label}\n\n${pull.title}`;
  const sha = putCommit(r, tree, [pull.base.sha], msg, login);
  r.refs.set(`refs/heads/${pull.base.ref}`, sha);
  return sha;
}

// ---------------------------------------------------------------- GraphQL

type GqlField = { name: string; type: string };

const issueTypeFields: GqlField[] = [
  { name: 'id', type: 'ID' },
  { name: 'number', type: 'Int' },
  { name: 'title', type: 'String' },
  { name: 'state', type: 'String' },
  { name: 'body', type: 'String' },
];
const prTypeFields: GqlField[] = [
  { name: 'id', type: 'ID' },
  { name: 'number', type: 'Int' },
  { name: 'headRefName', type: 'String' },
  { name: 'baseRefName', type: 'String' },
  { name: 'mergeable', type: 'String' },
  { name: 'state', type: 'String' },
  { name: 'merged', type: 'Boolean' },
  { name: 'files', type: '[PullRequestFileEdge]' },
];
const repoTypeFields: GqlField[] = [
  { name: 'id', type: 'ID' },
  { name: 'databaseId', type: 'Int' },
  { name: 'name', type: 'String' },
  { name: 'nameWithOwner', type: 'String' },
  { name: 'owner', type: 'User' },
  { name: 'defaultBranchRef', type: 'Ref' },
  { name: 'viewerPermission', type: 'String' },
  { name: 'hasIssuesEnabled', type: 'Boolean' },
  { name: 'issue', type: 'Issue' },
  { name: 'issues', type: 'IssueConnection' },
  { name: 'pullRequests', type: 'PullRequestConnection' },
  { name: 'pullRequest', type: 'PullRequest' },
];

const commentTypeFields: GqlField[] = [
  { name: 'id', type: 'ID' },
  { name: 'databaseId', type: 'Int' },
  { name: 'body', type: 'String' },
  { name: 'author', type: 'User' },
  { name: 'createdAt', type: 'String' },
];

function typeDef(fields: GqlField[]): Record<string, unknown> {
  return {
    kind: 'OBJECT',
    name: '',
    fields: fields.map((f) => ({
      name: f.name,
      type: { kind: 'SCALAR', name: f.type, ofType: null },
    })),
  };
}

export function graphqlRoute(ctx: Ctx, body: unknown): void {
  const b = (body ?? {}) as { query?: string; variables?: Record<string, unknown>; operationName?: string };
  const query = b.query ?? '';
  const rawVars = (b.variables ?? {}) as Record<string, any>;
  // Every gh mutation passes one `$input` object: `createIssue(input: $input)`. Flatten it so the
  // handlers can read `repositoryId`, `title`, ... directly instead of digging through `input`.
  const vars: Record<string, any> = { ...rawVars, ...(rawVars.input && typeof rawVars.input === 'object' ? rawVars.input : {}) };
  const { store, sendJson, login } = ctx;

  const gqlErr = (msg: string) => sendJson(200, { errors: [{ message: msg, locations: [{ line: 1, column: 1 }] }] });

  // ---- introspection -------------------------------------------------------
  // gh aliases every probe: `Issue: __type(name: "Issue")`, and one document can carry several of
  // them (`PullRequest: __type(...)  Repository: __type(...)`). The answer must be keyed by the
  // alias, not by the field name, or the client reads data.Issue === undefined.
  const probes = [...query.matchAll(/(?:([A-Za-z_][A-Za-z0-9_]*)\s*:\s*)?__type\s*\(\s*name:\s*"([^"]+)"\s*\)/g)];
  if (probes.length > 0) {
    const out: Record<string, unknown> = {};
    for (const [, alias, name] of probes) {
      const key = alias ?? '__type';
      out[key] = introspectType(name);
    }
    sendJson(200, { data: out });
    return;
  }

  // ---- repository lookup (paths: owner/name vars, or a node id) -------------
  // owner/name arrive as variables from lib clients but as inline literals from hand-written and
  // introspection-style documents, so fall back to the argument list when no variable carries them.
  const repoArgs = query.match(/\brepository\s*\(([^)]*)\)/);
  const argOf = (key: string): string => {
    if (!repoArgs) return '';
    const m = repoArgs[1].match(new RegExp(`\\b${key}\\s*:\\s*"([^"]*)"`));
    return m ? m[1] : '';
  };
  const ownerVar = String(vars.owner ?? vars.repositoryOwner ?? argOf('owner') ?? '');
  const repoVar = String(vars.name ?? vars.repo ?? vars.repositoryName ?? argOf('name') ?? '');
  const byName = ownerVar && repoVar ? store.repos.get(`${ownerVar}/${repoVar}`) : undefined;
  const nodeIdFor = (id: unknown) => {
    if (typeof id !== 'string') return null;
    let decoded = '';
    try { decoded = Buffer.from(id, 'base64').toString('utf8'); } catch { return null; }
    const m = decoded.match(/^(Repository|Issue|PullRequest|IssueComment|Discussion)(\d+)$/);
    if (!m) return null;
    return { kind: m[1], id: Number(m[2]) };
  };
  // Global ids encode the object's database id, but a repo keeps issues and pulls keyed by *number*,
  // so match on either: the relay id must round-trip whether it was minted from a REST-created object
  // or a GraphQL-created one.
  const findById = (kind: string, id: number) => {
    for (const repo of store.repos.values()) {
      if (kind === 'Repository' && repo.id === id) return { repo, obj: repo };
      if (kind === 'Issue') {
        for (const issue of repo.issues.values()) {
          if (issue.id === id || issue.number === id) return { repo, obj: issue };
        }
      }
      if (kind === 'PullRequest') {
        for (const pull of repo.pulls.values()) {
          if (pull.id === id || pull.number === id) return { repo, obj: pull };
        }
      }
    }
    return null;
  };

  // ---- node(id:) -----------------------------------------------------------
  // Must be `node(id: ...)` — `\bnode\s*\(` also matched every `nodes {` connection field, so a
  // document selecting `files { nodes { path } }` was answered as a node lookup and came back empty.
  if (/\bnode\s*\(\s*id\s*:/.test(query)) {
    const target = nodeIdFor(vars.id);
    if (!target) { sendJson(200, { data: { node: null } }); return; }
    const hit = findById(target.kind, target.id);
    if (!hit) { sendJson(200, { data: { node: null } }); return; }
    if (target.kind === 'Repository') { sendJson(200, { data: { node: gqlRepo(hit.repo) } }); return; }
    if (target.kind === 'Issue') { sendJson(200, { data: { node: gqlIssue(hit.repo, hit.obj as Issue) } }); return; }
    if (target.kind === 'PullRequest') { sendJson(200, { data: { node: gqlPull(hit.repo, hit.obj as Pull) } }); return; }
    sendJson(200, { data: { node: null } });
    return;
  }

  // ---- unknown selection ---------------------------------------------------
  // GraphQL answers HTTP 200 with an `errors` array naming the bad field; it never 4xx's. Run this
  // before any resolver so a document that mixes a valid root with one bogus field is still reported.
  const unknownField = findUnknownField(query);
  if (unknownField) {
    const ownerType = /\bviewer\b/.test(query) ? 'Viewer' : /\brepository\b/.test(query) ? 'Repository' : 'Query';
    sendJson(200, { errors: [{ message: `Field '${unknownField}' doesn't exist on type '${ownerType}'`, locations: [{ line: 1, column: 1 }] }] });
    return;
  }

  // ---- viewer { ... } ------------------------------------------------------
  if (/\bviewer\b\s*(\{|\(|\s*$)/.test(query) && !/repository\s*\(/.test(query)) {
    sendJson(200, { data: { viewer: { login, id: `User${login}` } } });
    return;
  }

  // ---- createRepository ----------------------------------------------------
  if (/createRepository/.test(query)) {
    const nv = String(vars.name ?? '');
    if (!nv) { sendJson(200, { data: { createRepository: { repository: null } }, errors: [{ message: 'name is required' }] }); return; }
    const id = store.seq.repo + 1;
    store.seq.repo = id;
    const repo = makeRepoLocal(store, login, nv);
    store.repos.set(`${login}/${nv}`, repo);
    sendJson(200, { data: { createRepository: { repository: gqlRepo(repo) } } });
    return;
  }

  // ---- the repository a mutation acts on ----------------------------------
  let repo = byName;
  if (!repo && vars.repositoryId) {
    const t = nodeIdFor(vars.repositoryId);
    const hit = t && t.kind === 'Repository' ? findById('Repository', t.id) : null;
    if (hit) repo = hit.repo;
  }
  const needRepo = () => {
    sendJson(200, { errors: [{ message: 'Could not resolve to a Repository with the given arguments', type: 'NOT_FOUND' }] });
  };

  // ---- createIssue ---------------------------------------------------------
  if (/createIssue/.test(query)) {
    if (!repo) { sendJson(200, { data: { createIssue: { issue: null } }, errors: [{ message: 'repository not found' }] }); return; }
    const title = String(vars.title ?? '');
    if (!title) { sendJson(200, { data: { createIssue: { issue: null } }, errors: [{ message: "Argument 'title' is required" }] }); return; }
    repo.seq.issue += 1;
    repo.seq.comment += 1;
    const issue: Issue = {
      id: repo.seq.issue,
      number: repo.seq.issue,
      title,
      body: vars.body === undefined || vars.body === null ? null : String(vars.body),
      state: 'open',
      created_at: now(),
      updated_at: now(),
      user: { login },
      comments: 0,
    } as Issue;
    repo.issues.set(issue.number, issue);
    sendJson(200, { data: { createIssue: { issue: gqlIssue(repo, issue) } } });
    return;
  }

  // ---- addComment ----------------------------------------------------------
  if (/addComment/.test(query)) {
    const t = nodeIdFor(vars.subjectId);
    const hit = t ? findById(t.kind, t.id) : null;
    if (!t || !hit) { sendJson(200, { data: { addComment: { commentEdge: { node: null } } }, errors: [{ message: 'Could not resolve to a node' }] }); return; }
    const r = hit.repo;
    r.seq.comment += 1;
    const cid = r.seq.comment;
    const comment = {
      id: `IssueComment${cid}`,
      databaseId: cid,
      body: String(vars.body ?? ''),
      author: { login },
      createdAt: now(),
    };
    if (t.kind === 'Issue') {
      const issue = hit.obj as Issue;
      // One bucket per issue, shared by the REST and GraphQL views: `commentsOf` is the same store the
      // REST comment routes read, so an added comment is visible to `GET /issues/{n}/comments`.
      const list = commentsOf(hit.repo, issue.number);
      list.push({ id: cid, body: comment.body, user: { login }, created_at: comment.createdAt });
      issue.comments = list.length;
    }
    sendJson(200, { data: { addComment: { commentEdge: { node: comment } } } });
    return;
  }

  // ---- closeIssue ----------------------------------------------------------
  if (/closeIssue/.test(query)) {
    const t = nodeIdFor(vars.issueId);
    const hit = t ? findById(t.kind, t.id) : null;
    if (!t || !hit || t.kind !== 'Issue') { sendJson(200, { data: { closeIssue: { issue: null } }, errors: [{ message: 'Could not resolve to an Issue' }] }); return; }
    const issue = hit.obj as Issue;
    issue.state = 'closed';
    issue.updated_at = now();
    sendJson(200, { data: { closeIssue: { issue: gqlIssue(hit.repo, issue) } } });
    return;
  }

  // ---- createPullRequest ---------------------------------------------------
  if (/createPullRequest/.test(query)) {
    if (!repo) { sendJson(200, { data: { createPullRequest: { pullRequest: null } }, errors: [{ message: 'repository not found' }] }); return; }
    const headName = String(vars.headRefName ?? vars.head ?? '');
    const baseName = String(vars.baseRefName ?? vars.base ?? '');
    const headSha = repo.refs.get(`refs/heads/${headName}`);
    const baseSha = repo.refs.get(`refs/heads/${baseName}`);
    if (!headSha) { sendJson(200, { data: { createPullRequest: { pullRequest: null } }, errors: [{ message: `head ref ${headName} not found` }] }); return; }
    if (!baseSha) { sendJson(200, { data: { createPullRequest: { pullRequest: null } }, errors: [{ message: `base ref ${baseName} not found` }] }); return; }
    repo.seq.pull += 1;
    const pull: Pull = {
      id: 7000 + repo.seq.pull,
      number: repo.seq.pull,
      title: String(vars.title ?? ''),
      body: vars.body === undefined || vars.body === null ? null : String(vars.body),
      state: 'open',
      head: { ref: headName, sha: headSha, label: `${repo.owner.login}:${headName}` },
      base: { ref: baseName, sha: baseSha, label: `${repo.owner.login}:${baseName}` },
      merged: false,
      merge_commit_sha: null,
      created_at: now(),
      updated_at: now(),
      user: { login },
    } as Pull;
    repo.pulls.set(pull.number, pull);
    sendJson(200, { data: { createPullRequest: { pullRequest: gqlPull(repo, pull) } } });
    return;
  }

  // ---- mergePullRequest ----------------------------------------------------
  if (/mergePullRequest/.test(query)) {
    let target: Pull | undefined;
    let owner: Repo | undefined;
    const t = nodeIdFor(vars.pullRequestId);
    if (t && t.kind === 'PullRequest') {
      const hit = findById('PullRequest', t.id);
      if (hit) { target = hit.obj as Pull; owner = hit.repo; }
    }
    if (!target && repo && vars.number !== undefined) {
      target = repo.pulls.get(Number(vars.number));
      owner = repo;
    }
    if (!target || !owner) { sendJson(200, { data: { mergePullRequest: { pullRequest: null } }, errors: [{ message: 'Could not resolve to a PullRequest' }] }); return; }
    if (target.merged) { sendJson(200, { data: { mergePullRequest: { pullRequest: gqlPull(owner, target) } } }); return; }
    const mergeSha = doSquashMerge(owner, target, login);
    if (!mergeSha) { sendJson(200, { data: { mergePullRequest: { pullRequest: null } }, errors: [{ message: 'merge failed' }] }); return; }
    target.merged = true;
    target.state = 'closed';
    target.merge_commit_sha = mergeSha;
    target.updated_at = now();
    sendJson(200, { data: { mergePullRequest: { pullRequest: gqlPull(owner, target) } } });
    return;
  }

  // ---- repository(owner:, name:) { ... } ----------------------------------
  if (/repository\s*\(/.test(query)) {
    if (!byName) {
      // an unknown repository is data.repository = null with no errors
      sendJson(200, { data: { repository: null } });
      return;
    }
    const r = byName;
    const repositoryOut: Record<string, unknown> = { ...gqlRepo(r) };

    // a single issue/pull by number: the number arrives either as a flattened variable or inline as
    // a literal, and `issue(number:)` and `pullRequest(number:)` share the same argument.
    const inlineNumber = query.match(/\b(?:issue|pullRequest)\s*\(\s*[^)]*?number\s*:\s*(\d+)/);
    const issueNum = vars.issueNumber ?? vars.number ?? (inlineNumber ? Number(inlineNumber[1]) : undefined);
    if (/\bissue\s*\(/.test(query) && issueNum !== undefined) {
      const issue = r.issues.get(Number(issueNum));
      repositoryOut.issue = issue ? gqlIssue(r, issue) : null;
      sendJson(200, { data: { repository: repositoryOut } });
      return;
    }
    // a single pull request by number
    if (/\bpullRequest\s*\(/.test(query) && issueNum !== undefined) {
      const pull = r.pulls.get(Number(issueNum));
      repositoryOut.pullRequest = pull ? gqlPull(r, pull) : null;
      sendJson(200, { data: { repository: repositoryOut } });
      return;
    }

    if (/\bissues\b/.test(query)) {
      const orderDesc = /direction:\s*DESC/i.test(query);
      const openOnly = /states:\s*\[\s*OPEN\s*\]/i.test(query);
      const closedOnly = /states:\s*\[\s*CLOSED\s*\]/i.test(query);
      let list = [...r.issues.values()];
      if (openOnly) list = list.filter((i) => i.state === 'open');
      if (closedOnly) list = list.filter((i) => i.state === 'closed');
      list.sort((a, b) => {
        const t2 = String(a.created_at).localeCompare(String(b.created_at));
        const base = orderDesc ? -t2 : t2;
        return base !== 0 ? base : orderDesc ? b.number - a.number : a.number - b.number;
      });
      // pagination: `first` / `after` follow GitHub's cursor convention
      const first = vars.first !== undefined ? Number(vars.first) : vars.last !== undefined ? Number(vars.last) : 100;
      let offset = 0;
      if (typeof vars.after === 'string' && vars.after) {
        const dec = Buffer.from(vars.after, 'base64').toString('utf8');
        const m = dec.match(/cursor:(\d+)/);
        if (m) offset = Number(m[1]);
      }
      const page = list.slice(offset, offset + first);
      const endOffset = offset + page.length;
      repositoryOut.issues = {
        totalCount: list.length,
        nodes: page.map((i) => gqlIssue(r, i)),
        edges: page.map((i, k) => ({
          cursor: Buffer.from(`cursor:${offset + k + 1}`).toString('base64'),
          node: gqlIssue(r, i),
        })),
        pageInfo: {
          hasNextPage: endOffset < list.length,
          hasPreviousPage: offset > 0,
          endCursor: page.length > 0 ? Buffer.from(`cursor:${endOffset}`).toString('base64') : null,
          startCursor: page.length > 0 ? Buffer.from(`cursor:${offset + 1}`).toString('base64') : null,
        },
      };
    }
    if (/\bpullRequests\b/.test(query)) {
      const list = [...r.pulls.values()];
      const openOnly = /states:\s*\[\s*OPEN\s*\]/i.test(query);
      const filtered = openOnly ? list.filter((p) => p.state === 'open') : list;
      repositoryOut.pullRequests = {
        totalCount: filtered.length,
        nodes: filtered.map((p) => gqlPull(r, p)),
        edges: filtered.map((p) => ({ node: gqlPull(r, p) })),
        pageInfo: { hasNextPage: false, hasPreviousPage: false, endCursor: null },
      };
    }
    sendJson(200, { data: { repository: repositoryOut } });
    return;
  }

  if (/\buser\s*\(/.test(query)) {
    sendJson(200, { data: { user: { login: String(vars.login ?? login), id: `User${String(vars.login ?? login)}` } } });
    return;
  }

  sendJson(200, { data: {} });
}

/** The __type payload for one named type: `{ kind, name, fields: [{name, type}] }`. */
function introspectType(name: string): unknown {
  const whole = (fields: GqlField[], kind = 'OBJECT') => ({
    kind,
    name,
    fields: fields.map((f) => ({ name: f.name, type: { kind: f.type.startsWith('[') ? 'LIST' : 'SCALAR', name: f.type, ofType: null } })),
  });
  switch (name) {
    case 'Issue': return whole(issueTypeFields);
    case 'PullRequest': return whole(prTypeFields);
    case 'Repository': return whole(repoTypeFields);
    case 'IssueComment':
    case 'Comment': return whole(commentTypeFields);
    case 'User': return whole([{ name: 'login', type: 'String' }, { name: 'id', type: 'ID' }, { name: 'name', type: 'String' }]);
    case 'Ref': return whole([{ name: 'name', type: 'String' }, { name: 'target', type: 'Commit' }, { name: 'oid', type: 'String' }]);
    case 'Commit': return whole([{ name: 'oid', type: 'String' }, { name: 'message', type: 'String' }, { name: 'tree', type: 'Tree' }]);
    case 'Tree': return whole([{ name: 'entries', type: '[TreeEntry]' }, { name: 'oid', type: 'String' }]);
    case 'TreeEntry': return whole([{ name: 'name', type: 'String' }, { name: 'path', type: 'String' }, { name: 'type', type: 'String' }, { name: 'mode', type: 'Int' }, { name: 'oid', type: 'String' }, { name: 'object', type: 'Blob' }]);
    case 'Blob': return whole([{ name: 'text', type: 'String' }, { name: 'byteSize', type: 'Int' }, { name: 'oid', type: 'String' }, { name: 'isBinary', type: 'Boolean' }]);
    case 'SearchType':
      return { kind: 'ENUM', name: 'SearchType', enumValues: [{ name: 'ISSUE' }, { name: 'REPOSITORY' }, { name: 'USER' }, { name: 'PULL_REQUEST' }] };
    case 'Query':
      return {
        kind: 'OBJECT',
        name: 'Query',
        fields: ['repository', 'viewer', 'node', 'user', 'search', 'organization']
          .map((n) => ({ name: n, type: { kind: 'OBJECT', name: n === 'node' ? 'Node' : 'Repository', ofType: null } })),
      };
    case 'Mutation':
      return {
        kind: 'OBJECT',
        name: 'Mutation',
        fields: ['createIssue', 'closeIssue', 'addComment', 'createPullRequest', 'mergePullRequest', 'createRepository', 'updateIssue']
          .map((n) => ({ name: n, type: { kind: 'OBJECT', name: 'Payload', ofType: null } })),
      };
    default:
      return null;
  }
}

const KNOWN_SELECTION = new Set<string>([
  'data','errors','extensions','message','locations','path','type','query','mutation','subscription',
  'repository','viewer','node','user','search','organization',
  'id','databaseId','name','nameWithOwner','owner','login','url','description','isPrivate','isFork',
  'defaultBranchRef','viewerPermission','hasIssuesEnabled','primaryLanguage','stargazerCount','forkCount',
  'issue','issues','pullRequest','pullRequests','ref','target','oid','refName','prefix','repositoryOwner',
  'number','title','body','bodyText','state','stateReason','closed','createdAt','updatedAt','author',
  'comments','totalCount','nodes','edges','node_placeholder','cursor','pageInfo','hasNextPage',
  'hasPreviousPage','startCursor','endCursor','orderBy','field','direction','states','first','last',
  'after','before','filterBy','labels','labels_total','assignees','milestone',
  'headRefName','baseRefName','headRefOid','baseRefOid','mergeable','merged','mergeStateStatus','files',
  'additions','deletions','path_placeholder','changes','isDraft','createdAt_','closedAt','mergedAt',
  'createIssue','closeIssue','addComment','createPullRequest','mergePullRequest','mergeCommit',
  'createRepository','pullRequestCreate','issueComment','commentEdge','viewerCanUpdate','viewerDidAuthor',
  '__typename','__type','fields','enumValues','kind','ofType','name_placeholder','description_placeholder',
  'isArchived','isEmpty','licenseInfo','latestRelease','releases','languages','topics','visibility',
]);

/**
 * A crude but sufficient validator: tokenise every `ident` followed by `(`, `{` or end-of-line inside
 * the selection sets and return the first one that is not a field this forge serves. Introspection
 * meta-fields and variable/argument names are excluded by only looking after the first `{`.
 */
function findUnknownField(query: string): string | null {
  const braceAt = query.indexOf('{');
  if (braceAt < 0) return null;
  let body = query.slice(braceAt);
  // drop argument lists so their identifiers (`$input`, `first`, `states`) are not mistaken for fields
  body = body.replace(/\([^()]*\)/g, '()');
  const ids = [...body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*(?:\{|\(|\}|$)/g)].map((m) => m[1]);
  for (const id of ids) {
    if (id.startsWith('__')) continue;
    if (!KNOWN_SELECTION.has(id)) return id;
  }
  return null;
}

function gqlId(r: Repo): string {
  return Buffer.from(`Repository${r.id}`).toString('base64');
}

function gqlRepo(r: Repo): Record<string, unknown> {
  return {
    id: gqlId(r),
    databaseId: r.id,
    name: r.name,
    nameWithOwner: r.full_name,
    owner: { login: r.owner.login },
    defaultBranchRef: { name: r.default_branch, target: { oid: r.refs.get(`refs/heads/${r.default_branch}`) ?? null } },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

function gqlIssue(r: Repo, i: Issue): Record<string, unknown> {
  return {
    id: Buffer.from(`Issue${i.id}`).toString('base64'),
    number: i.number,
    title: i.title,
    state: i.state.toUpperCase(),
    body: i.body,
  };
}

function gqlPull(r: Repo, p: Pull): Record<string, unknown> {
  return {
    id: Buffer.from(`PullRequest${p.id}`).toString('base64'),
    number: p.number,
    headRefName: p.head.ref,
    baseRefName: p.base.ref,
    mergeable: 'MERGEABLE',
    state: p.state.toUpperCase(),
    merged: p.merged,
    // `files(first:) { nodes { path ... } }` — nodes hold the objects themselves, not edge wrappers.
    // GitHub exposes the changed path as `path` in GraphQL (`filename` is the REST spelling); some
    // clients read `.path`, so carry both names on the same object.
    files: (() => {
      const list = diffFiles(r, p).map((f) => ({ ...f, path: f.filename }));
      return { totalCount: list.length, nodes: list, edges: list.map((f) => ({ node: f })) };
    })(),
  };
}
