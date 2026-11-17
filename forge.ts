// ghforge — a standalone, GitHub-compatible git forge.
// Serves: git smart HTTP (upload-pack v2, receive-pack v0), REST v3, GraphQL v4, and MCP.
// No external services, no git binary: everything is its own store.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- store

export type Store = {
  repos: Map<string, Repo>;
};

export type Repo = {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  description: string | null;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  // git objects
  objects: Map<string, { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer }>;
  refs: Map<string, string>; // refs/heads/... -> sha
  // REST resources
  issues: Map<number, Issue>;
  labels: Map<string, { id: number; name: string; color: string }>;
  pulls: Map<number, Pull>;
  /** Issue comments, keyed by the issue number they belong to. */
  comments: Map<number, Comment[]>;
  seq: { issue: number; label: number; pull: number; repo: number; comment: number };
};

export type Issue = {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: { id: number; name: string; color: string }[];
  created_at: string;
  updated_at: string;
  user: { login: string };
};

export type Pull = {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  head: { ref: string; sha: string; label: string };
  base: { ref: string; sha: string; label: string };
  merged: boolean;
  merge_commit_sha: string | null;
  created_at: string;
  updated_at: string;
  user: { login: string };
};

const now = (): string => new Date().toISOString();
const sha1 = (buf: Buffer | string): string => createHash('sha1').update(buf).digest('hex');

/** git object id of a blob/tree/commit body, with git's header. */
function gitOid(type: 'blob' | 'tree' | 'commit' | 'tag', body: Buffer): string {
  return sha1(Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]));
}

export type Comment = { id: number; body: string; user: { login: string }; created_at: string };

export function createStore(): Store {
  return { repos: new Map() };
}

let repoSeq = 0;

export function makeRepo(store: Store, owner: string, name: string): Repo {
  const full = `${owner}/${name}`;
  const existing = store.repos.get(full);
  if (existing) return existing;
  repoSeq += 1;
  const r: Repo = {
    id: 1000 + repoSeq,
    name,
    full_name: full,
    owner: { login: owner },
    description: null,
    private: false,
    default_branch: 'main',
    created_at: now(),
    updated_at: now(),
    objects: new Map(),
    refs: new Map(),
    issues: new Map(),
    labels: new Map(),
    pulls: new Map(),
    comments: new Map(),
    seq: { issue: 0, label: 0, pull: 0, repo: repoSeq, comment: 0 },
  };
  store.repos.set(full, r);
  return r;
}

// ---------------------------------------------------------------- git object encode / decode

/** Compute the tree object id of a directory listing. */
export function writeTree(entries: { mode: string; name: string; sha: string; type: 'blob' | 'tree' }[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    // git sorts trees as if their name had a trailing '/'
    const an = a.type === 'tree' ? `${a.name}/` : a.name;
    const bn = b.type === 'tree' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Object type and body out of a sha1 (git's loose object convention). */
export function readObject(r: Repo, sha: string): { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer } | null {
  return r.objects.get(sha) ?? null;
}

export function putObject(r: Repo, type: 'blob' | 'tree' | 'commit' | 'tag', body: Buffer): string {
  const oid = gitOid(type, body);
  if (!r.objects.has(oid)) r.objects.set(oid, { type, data: body });
  return oid;
}

/** A commit's tree and parent, parsed from its raw body. */
export function parseCommit(body: Buffer): { tree: string; parents: string[]; message: string } {
  const text = body.toString('utf8');
  const headerEnd = text.indexOf('\n\n');
  const headers = headerEnd === -1 ? text : text.slice(0, headerEnd);
  const message = headerEnd === -1 ? '' : text.slice(headerEnd + 2);
  let tree = '';
  const parents: string[] = [];
  for (const line of headers.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

export function buildCommit(tree: string, parents: string[], message: string, author: { name: string; email: string; when?: string }): Buffer {
  const when = author.when ?? `${Math.floor(Date.now() / 1000)} +0000`;
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${author.name} <${author.email}> ${when}`);
  lines.push(`committer ${author.name} <${author.email}> ${when}`);
  lines.push('');
  lines.push(message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/**
 * Walk a commit's tree and return every file path with its blob sha.
 * Used by contents, clone, and the flatten/merge path.
 */
export function flattenTree(r: Repo, treeSha: string, prefix = ''): Map<string, { sha: string; mode: string }> {
  const out = new Map<string, { sha: string; mode: string }>();
  const obj = readObject(r, treeSha);
  if (!obj || obj.type !== 'tree') return out;
  let i = 0;
  const data = obj.data;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, sp);
    if (sp === -1 || nul === -1) break;
    const mode = data.slice(i, sp).toString('utf8');
    const name = data.slice(sp + 1, nul).toString('utf8');
    const sha = data.slice(nul + 1, nul + 21).toString('hex');
    i = nul + 21;
    const path = prefix === '' ? name : `${prefix}/${name}`;
    if (mode === '40000' || mode === '040000') {
      for (const [p, v] of flattenTree(r, sha, path)) out.set(p, v);
    } else {
      out.set(path, { sha, mode });
    }
  }
  return out;
}

/** Rebuild a tree hierarchy from a flat path -> blob map. */
export function buildTreeFromPaths(r: Repo, files: Map<string, { sha: string; mode: string }>): string {
  type Node = { files: Map<string, { sha: string; mode: string }>; dirs: Map<string, Node> };
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, v] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const d = parts[i];
      if (!node.dirs.has(d)) node.dirs.set(d, { files: new Map(), dirs: new Map() });
      node = node.dirs.get(d)!;
    }
    node.files.set(parts[parts.length - 1], v);
  }
  const emit = (node: Node): string => {
    const entries: { mode: string; name: string; sha: string; type: 'blob' | 'tree' }[] = [];
    for (const [name, v] of node.files) entries.push({ mode: v.mode === '100755' ? '100755' : '100644', name, sha: v.sha, type: 'blob' });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, sha: emit(child), type: 'tree' });
    return putObject(r, 'tree', writeTree(entries));
  };
  return emit(root);
}

// ---------------------------------------------------------------- packfile

/** Decode a whole packfile into {type, data} objects, verifying each object's id. */
export function readPack(
  pack: Buffer,
  known: ReadonlyMap<string, { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer }> = new Map(),
): { oid: string; type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer }[] {
  const out: { oid: string; type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer }[] = [];
  if (pack.length < 32) return out;
  if (pack.slice(0, 4).toString('ascii') !== 'PACK') return out;
  const typeNames = ['', 'commit', 'tree', 'blob', 'tag'] as const;
  const byOffset = new Map<number, { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer; oid: string; next: number }>();
  const byId = new Map<string, { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer }>();

  const readVarint = (start: number): { value: number; next: number } => {
    let p = start;
    let shift = 0;
    let value = 0;
    for (;;) {
      const b = pack[p];
      p += 1;
      value += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return { value, next: p };
  };

  const parseAt = (offset: number): { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer; oid: string; next: number } | null => {
    const cached = byOffset.get(offset);
    if (cached) return cached;
    let p = offset;
    let b = pack[p];
    p += 1;
    const typeNum = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while ((b & 0x80) !== 0) {
      b = pack[p];
      p += 1;
      size += (b & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let type: 'blob' | 'tree' | 'commit' | 'tag';
    let data: Buffer;
    if (typeNum === 6) {
      const ofs = readVarint(p);
      p = ofs.next;
      const base = parseAt(offset - ofs.value);
      if (!base) return null;
      const inflated = inflateAt(pack, p, size);
      data = applyDelta(base.data, inflated.data);
      type = base.type;
      p = inflated.next;
    } else if (typeNum === 7) {
      const baseSha = pack.slice(p, p + 20).toString('hex');
      p += 20;
      // A thin pack (the usual push after a fetch) names bases the receiver already holds, so a
      // REF_DELTA whose base is not inside this pack must resolve against the repository's objects.
      const base = byId.get(baseSha) ?? known.get(baseSha);
      if (!base) return null;
      byId.set(baseSha, base);
      const inflated = inflateAt(pack, p, size);
      data = applyDelta(base.data, inflated.data);
      type = base.type;
      p = inflated.next;
    } else {
      type = typeNames[typeNum] as 'blob' | 'tree' | 'commit' | 'tag';
      if (type === undefined) return null;
      const inflated = inflateAt(pack, p, size);
      data = inflated.data;
      p = inflated.next;
    }
    const oid = gitOid(type, data);
    const rec = { type, data, oid, next: p };
    byOffset.set(offset, rec);
    byId.set(oid, { type, data });
    return rec;
  };

  const count = pack.readUInt32BE(8);
  let pos = 12;
  for (let n = 0; n < count; n += 1) {
    if (pos >= pack.length - 20) break;
    const rec = parseAt(pos);
    if (!rec) break;
    out.push({ oid: rec.oid, type: rec.type, data: rec.data });
    pos = rec.next;
  }
  return out;
}

/**
 * Decompress the deflate stream at `pos`. `expected` is the object's inflated size when known
 * (the pack header states it), which makes the exact stream end findable; unknown grows a window.
 */
function inflateAt(buf: Buffer, pos: number, expected?: number): { data: Buffer; next: number } {
  if (expected !== undefined && expected >= 0) {
    const budget = expected + 1024;
    const data = inflateSync(buf.subarray(pos, Math.min(buf.length, pos + budget * 2 + 64)));
    return { data, next: pos + compressedLength(buf, pos, data.length) };
  }
  for (let span = 8; span <= buf.length - pos; span = Math.min(Math.max(span * 2, 8), buf.length - pos)) {
    try {
      const data = inflateSync(buf.subarray(pos, pos + span));
      for (let exact = 8; exact <= span; exact += 1) {
        try {
          const d2 = inflateSync(buf.subarray(pos, pos + exact));
          if (d2.length === data.length) return { data: d2, next: pos + exact };
        } catch {
          /* not yet */
        }
      }
      return { data, next: pos + span };
    } catch {
      /* keep growing */
    }
  }
  return { data: inflateSync(buf.subarray(pos)), next: buf.length };
}

/** The compressed length of the stream that inflated to `inflatedSize` bytes at `pos`. */
function compressedLength(buf: Buffer, pos: number, inflatedSize: number): number {
  for (let exact = 8; exact <= buf.length - pos; exact += 1) {
    try {
      const d = inflateSync(buf.subarray(pos, pos + exact));
      if (d.length === inflatedSize) return exact;
    } catch {
      /* not yet */
    }
  }
  return buf.length - pos;
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = delta[p];
      p += 1;
      value += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return value;
  };
  readSize(); // base size, unchecked
  const targetSize = readSize();
  const out = Buffer.alloc(targetSize);
  let o = 0;
  while (p < delta.length) {
    const cmd = delta[p];
    p += 1;
    if (cmd === 0) break;
    if ((cmd & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if (cmd & 0x01) { offset += delta[p] * 2 ** 0; p += 1; }
      if (cmd & 0x02) { offset += delta[p] * 2 ** 8; p += 1; }
      if (cmd & 0x04) { offset += delta[p] * 2 ** 16; p += 1; }
      if (cmd & 0x08) { offset += delta[p] * 2 ** 24; p += 1; }
      if (cmd & 0x10) { size += delta[p] * 2 ** 0; p += 1; }
      if (cmd & 0x20) { size += delta[p] * 2 ** 8; p += 1; }
      if (cmd & 0x40) { size += delta[p] * 2 ** 16; p += 1; }
      if (size === 0) size = 0x10000;
      base.copy(out, o, offset, offset + size);
      o += size;
    } else {
      delta.copy(out, o, p, p + cmd);
      o += cmd;
      p += cmd;
    }
  }
  return out;
}

/** Build a packfile (version 2) of the given objects, undeltified. */
export function buildPack(objects: { oid: string; type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const typeNum = { commit: 1, tree: 2, blob: 3, tag: 4 } as const;
  const parts: Buffer[] = [header];
  for (const o of objects) {
    const size = o.data.length;
    const typeBits = typeNum[o.type] << 4;
    let first = typeBits | (size & 0x0f);
    let rest = size >>> 4;
    const hdr: number[] = [];
    if (rest > 0) first |= 0x80;
    hdr.push(first);
    while (rest > 0) {
      let b = rest & 0x7f;
      rest >>>= 7;
      if (rest > 0) b |= 0x80;
      hdr.push(b);
    }
    parts.push(Buffer.from(hdr));
    parts.push(deflateSync(o.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Every object reachable from a set of commits (commits, trees, blobs). */
/**
 * Memo of `sha -> every object reachable from it`. A push workload walks the whole history once per
 * operation, which is quadratic over the run; caching each tip's closure and reusing it across
 * requests turns that back into one walk per new object.
 */
const reachCache = new WeakMap<Repo, Map<string, Set<string>>>();

export function reachableOids(r: Repo, startShas: string[]): Set<string> {
  let perRepo = reachCache.get(r);
  if (!perRepo) { perRepo = new Map(); reachCache.set(r, perRepo); }
  const result = new Set<string>();
  for (const start of startShas) {
    let closure = perRepo.get(start);
    if (!closure) {
      closure = new Set<string>();
      for (const o of reachableObjects(r, [start])) closure.add(o.oid);
      perRepo.set(start, closure);
    }
    for (const oid of closure) result.add(oid);
  }
  return result;
}

export function reachableObjects(r: Repo, startShas: string[]): { oid: string; type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer }[] {
  const seen = new Set<string>();
  const out: { oid: string; type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer }[] = [];
  const visit = (sha: string): void => {
    if (seen.has(sha)) return;
    seen.add(sha);
    const obj = readObject(r, sha);
    if (!obj) return;
    out.push({ oid: sha, type: obj.type, data: obj.data });
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      visit(c.tree);
      for (const p of c.parents) visit(p);
    } else if (obj.type === 'tree') {
      const obj2 = readObject(r, sha)!;
      const data = obj2.data;
      let i = 0;
      while (i < data.length) {
        const sp = data.indexOf(0x20, i);
        const nul = data.indexOf(0x00, sp);
        if (sp === -1 || nul === -1) break;
        const mode = data.slice(i, sp).toString('utf8');
        const childSha = data.slice(nul + 1, nul + 21).toString('hex');
        i = nul + 21;
        if (mode === '40000' || mode === '040000') visit(childSha);
        else visit(childSha);
      }
    }
  };
  for (const s of startShas) visit(s);
  return out;
}

/** Is `ancestor` reachable from `descendant` by following parents? */
export function isAncestor(r: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (sha === ancestor) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = readObject(r, sha);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}
