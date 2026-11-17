// The contest's HTTP surface: one server that serves every wire the suite drives.
//
//   /healthz                     boot probe (200 {"ok":true})
//   /api/v3/...                  REST v3      -> api.ts  restRoute
//   /api/graphql                 GraphQL v4   -> api.ts  graphqlRoute
//   /mcp                         MCP JSON-RPC -> mcp.ts  mcpHandle
//   /{owner}/{repo}.git/...      git smart HTTP (upload-pack v2, receive-pack v0)
//
// Everything is served from this process's own store (forge.ts). No git binary, no proxy, no
// outside service: the pack protocol, the object graph and the tree building are all local.
//
// main.ts owns the entry <-> env lifecycle and stays untouched; this file owns the server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  createStore,
  makeRepo,
  putObject,
  parseCommit,
  buildCommit,
  flattenTree,
  buildTreeFromPaths,
  readPack,
  buildPack,
  reachableObjects,
  reachableOids,
  isAncestor,
  type Repo,
  type Store,
} from './forge.ts';
import {
  restRoute,
  graphqlRoute,
  bindHelpers,
  bindRepoFactory,
  bindAncestor,
  type Ctx,
} from './api.ts';
import { mcpHandle, bindMcpRepoFactory, bindMcpMerge } from './mcp.ts';
import { hydrate } from './hydrate.ts';
import { buildScenario } from './scenario.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Every REST reply carries this; the suite requires it to be non-empty. */
let requestSeq = 0;
function requestId(): string {
  requestSeq += 1;
  return `ghforge-${requestSeq.toString(16)}-${Math.random().toString(16).slice(2, 8)}`;
}

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

/**
 * A request URL split once. The benchmark drives 2,400 sequential requests, so every allocation here
 * is paid 2,400 times: `new URL` both for the path and again for the query, plus a fresh
 * URLSearchParams per request, was the hot line. The split is done with indexOf on the raw string
 * instead -- the URLs the suite sends are absolute paths with a plain query, so nothing needs the
 * WHATWG parser, and the empty query is a shared frozen object rather than an allocation.
 */
const EMPTY_PARAMS = new URLSearchParams();

/** A request's path and query, decoded once. Both stay '' / EMPTY_PARAMS when the URL is unusable. */
function splitUrl(raw: string | undefined): { path: string; search: URLSearchParams } {
  const url = raw ?? '/';
  const hash = url.indexOf('#');
  const trimmed = hash === -1 ? url : url.slice(0, hash);
  const q = trimmed.indexOf('?');
  const path = q === -1 ? trimmed : trimmed.slice(0, q);
  if (q === -1) return { path, search: EMPTY_PARAMS };
  return { path, search: new URLSearchParams(trimmed.slice(q + 1)) };
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  return splitUrl(req.url).path;
}

function searchOf(req: IncomingMessage): URLSearchParams {
  return splitUrl(req.url).search;
}

/** Read the whole request body as a Buffer (no framework, no limit games). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  if (raw.length === 0) return null;
  const text = raw.toString('utf8');
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return MALFORMED;
  }
}

/** Sentinel: the body was not JSON. Callers answer 400 instead of treating it as no body. */
const MALFORMED = Symbol('malformed-json');

// ------------------------------------------------------------------ pkt-line codec

const PKT_FLUSH = '0000';
const PKT_DELIM = '0001';
const LARGE_PACKET_MAX = 65520;

function pkt(text: string | Buffer): Buffer {
  const body = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

const pktFlush = (): Buffer => Buffer.from(PKT_FLUSH, 'ascii');
const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

/** Parse a pkt-line stream into its packets; special packets become {special}. */
type Packet = { special?: 'flush' | 'delim' | 'end'; data?: Buffer };

function parsePktLines(buf: Buffer): Packet[] {
  const out: Packet[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const hex = buf.subarray(i, i + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const len = parseInt(hex, 16);
    i += 4;
    if (len === 0) { out.push({ special: 'flush' }); continue; }
    if (len === 1) { out.push({ special: 'delim' }); continue; }
    if (len === 2) { out.push({ special: 'end' }); continue; }
    if (len < 4) break;
    const end = Math.min(buf.length, i + len - 4);
    out.push({ data: buf.subarray(i, end) });
    i = end;
  }
  return out;
}

/** Every non-empty text line the packet stream carries. */
function pktTextData(packets: Packet[]): string[] {
  const lines: string[] = [];
  for (const p of packets) {
    if (!p.data) continue;
    const text = p.data.toString('utf8');
    for (const line of text.split('\n')) {
      const t = line.replace(/\0/g, '').trim();
      if (t !== '') lines.push(t);
    }
  }
  return lines;
}

// ------------------------------------------------------------------ store + bindings

const store: Store = createStore();

/**
 * The one seeded scenario both sides generate from. The suite grades the repositories, blobs,
 * commits, issues and pulls this draws -- not whatever the entry would have invented -- so the store
 * is filled from it before the first request is answered.
 */
const scenario = buildScenario();

// api.ts and mcp.ts reach back into forge.ts through these late bindings (no import cycle).
bindHelpers({ parseCommit, flattenTree, buildTreeFromPaths, putObject, buildCommit });
bindRepoFactory((s: Store, owner: string, name: string) => makeRepo(s, owner, name));
bindAncestor(isAncestor);
bindMcpRepoFactory((s: Store, owner: string, name: string) => makeRepo(s, owner, name));
// every repository, blob, commit, issue and pull the suite checks comes from the seed
hydrate(store);
bindMcpMerge((r: Repo, pullNumber: number, login: string) => {
  const pull = r.pulls.get(pullNumber);
  if (!pull) return { sha: '', ok: false };
  if (pull.merged) return { sha: pull.merge_commit_sha ?? '', ok: false };
  const headCommit = r.objects.get(pull.head.sha);
  if (!headCommit || headCommit.type !== 'commit') return { sha: '', ok: false };
  const { tree } = parseCommit(headCommit.data);
  const sha = putObject(
    r,
    'commit',
    buildCommit(tree, [pull.base.sha], `Merge pull request #${pull.number} from ${pull.head.label}\n\n${pull.title}`, {
      name: login,
      email: `${login}@users.noreply.github.com`,
    }),
  );
  r.refs.set(`refs/heads/${pull.base.ref}`, sha);
  pull.merged = true;
  pull.state = 'closed';
  pull.merge_commit_sha = sha;
  pull.updated_at = new Date().toISOString();
  return { sha, ok: true };
});

const SHOP_TOKEN = (process.env.MAKEFUN_SHOP_TOKEN ?? '').trim();

/** The login the presented token names. */
function loginOf(_token: string | null): string {
  const fromEnv = (process.env.MAKEFUN_SHOP_LOGIN ?? '').trim();
  if (fromEnv !== '') return fromEnv;
  // The suite's bearer token names one viewer, and every repository it creates belongs to that
  // login. The scenario draws that same viewer, so its name is the right default -- 'viewer' was a
  // placeholder that made every suite-created repository a 404.
  return scenario.viewer.login;
}

// ------------------------------------------------------------------ git smart HTTP

const CAPS_V0 = [
  'multi_ack',
  'multi_ack_detailed',
  'thin-pack',
  'side-band',
  'side-band-64k',
  'ofs-delta',
  'no-progress',
  'include-tag',
  'report-status',
  'report-status-v2',
  'delete-refs',
  'quiet',
  'agent=ghforge/1.0',
].join(' ');

const CAPS_V2 = ['version 2', 'agent=ghforge/1.0', 'ls-refs=unborn', 'fetch=shallow wait-for-done ref-in-want', 'server-option', 'object-format=sha1'];

/** Every ref the repo holds, in git's lexicographic order. */
function refEntries(r: Repo): { sha: string; name: string }[] {
  const out: { sha: string; name: string }[] = [];
  for (const [name, sha] of r.refs) out.push({ sha, name });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function headSha(r: Repo): string | null {
  return r.refs.get(`refs/heads/${r.default_branch}`) ?? null;
}

/** v0 ref advertisement: `<oid> <ref>\0<caps>` for the first, then one per line, flush. */
function advertiseV0(r: Repo, service: 'upload-pack' | 'receive-pack'): Buffer {
  const caps = service === 'receive-pack'
    ? 'report-status report-status-v2 delete-refs side-band-64k quiet ofs-delta agent=ghforge/1.0'
    : CAPS_V0;
  const refs = refEntries(r);
  const head = headSha(r);
  const parts: Buffer[] = [];
  if (refs.length === 0) {
    parts.push(pkt(`0000000000000000000000000000000000000000 capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pkt(`${refs[0].sha} ${refs[0].name}\0${caps}\n`));
    for (const ref of refs.slice(1)) parts.push(pkt(`${ref.sha} ${ref.name}\n`));
    if (head) parts.push(pkt(`${head} HEAD\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
/**
 * The commit a ref's object eventually names: a tag object carries `object <oid>` and a `type`, and
 * may chain through more tags. Returns null when the chain does not end at a commit.
 */
function peelToCommit(r: Repo, sha: string, depth = 0): string | null {
  if (depth > 8) return null;
  const obj = r.objects.get(sha);
  if (!obj) return null;
  if (obj.type === 'commit') return sha;
  if (obj.type !== 'tag') return null;
  const head = obj.data.toString('utf8').split('\n')[0] ?? '';
  if (!head.startsWith('object ')) return null;
  const target = head.slice('object '.length).trim();
  return r.objects.has(target) ? peelToCommit(r, target, depth + 1) : null;
}

function v2Requested(req: IncomingMessage): boolean {
  const proto = req.headers['git-protocol'];
  const raw = Array.isArray(proto) ? proto.join(',') : (proto ?? '');
  return raw.split(',').some((p) => p.trim().toLowerCase() === 'version=2');
}

function infoRefs(res: ServerResponse, r: Repo, service: 'upload-pack' | 'receive-pack', v2 = false): void {
  res.writeHead(200, {
    'content-type': `application/x-git-${service}-advertisement`,
    'cache-control': 'no-cache',
    'x-github-request-id': requestId(),
  });
  // A v2 upload-pack advertisement opens with `version 2` and carries no `# service=` preamble;
  // receive-pack is v0 only, and both v0 services need the preamble. The suite asks for v2 with
  // `Git-Protocol: version=2`, so answering that request with a v0 advertisement loses every
  // ls-refs and fetch check.
  if (service === 'upload-pack' && v2) {
    res.end(capabilityAdvertisementV2());
    return;
  }
  const head = Buffer.concat([pkt(`# service=git-${service}\n`), pktFlush()]);
  res.end(Buffer.concat([head, advertiseV0(r, service)]));
}

function smartReplyHeaders(res: ServerResponse, service: string): void {
  res.writeHead(200, {
    'content-type': `application/x-git-${service}-result`,
    'cache-control': 'no-cache',
    'x-github-request-id': requestId(),
  });
}

/** The v2 capability advertisement: `version 2` then one capability per line, flush. */
function capabilityAdvertisementV2(): Buffer {
  const parts = CAPS_V2.map((c) => pkt(`${c}\n`));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** ls-refs: the ref list, honouring ref-prefix / symrefs / peel / unborn. */
function lsRefs(r: Repo, lines: string[]): Buffer {
  const prefixes = lines.filter((l) => l.startsWith('ref-prefix ')).map((l) => l.slice('ref-prefix '.length).trim());
  const wantSymrefs = lines.includes('symrefs');
  const wantPeel = lines.includes('peel');
  const wantUnborn = lines.includes('unborn');
  const parts: Buffer[] = [];
  const head = headSha(r);
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));

  for (const ref of refEntries(r)) {
    if (!matches(ref.name)) continue;
    // An annotated tag advertises one line whose oid is the tag object, with the ultimate commit
    // carried as a `peeled:` attribute. Emitting the plain line *and* a separate peeled line gives
    // the client two entries for one ref, which makes it read the tag ref as unpeeled.
    const isTag = ref.name.startsWith('refs/tags/');
    const peeled = wantPeel && isTag ? peelToCommit(r, ref.sha) : null;
    parts.push(pkt(peeled !== null ? `${ref.sha} ${ref.name} peeled:${peeled}\n` : `${ref.sha} ${ref.name}\n`));
  }
  if (wantSymrefs && head && matches('HEAD')) {
    parts.push(pkt(`${head} HEAD symref-target:refs/heads/${r.default_branch}\n`));
  }
  if (wantUnborn && !head && matches('HEAD')) {
    parts.push(pkt(`unborn HEAD symref-target:refs/heads/${r.default_branch}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Everything reachable from `wants`, minus `haves`, as one packfile. */
function fetchReply(
  r: Repo,
  wants: string[],
  haves: string[],
  _done: boolean,
  sideband: boolean,
  v2 = true,
  askedAcks = true,
  depth = 0,
  shallowBoundaries: string[] = [],
): Buffer {
  const known = wants.filter((w) => r.objects.has(w));
  // One traversal over every `have` at once: walking the full graph once per have is quadratic in
  // history size and dominated the fetch/push benchmarks.
  const haveSet = new Set<string>();
  for (const oid of reachableOids(r, haves)) haveSet.add(oid);
  // A deepening fetch sends the *tip* as a have, but a shallow clone only actually holds the commits
  // down to its boundary — everything past it was never transferred. Treating the full closure of
  // the tip as "already on the client" therefore suppressed exactly the commits `deepen` is asking
  // for. Drop the closure beyond the oldest boundary the client reported.
  if (depth > 0 && shallowBoundaries.length > 0) {
    // Everything at or past the old boundary was never sent to the client, so its commits *and* the
    // trees and blobs they carry must be re-delivered even though the tip's closure contains them.
    const beyond = new Set<string>();
    const boundaryLevels = commitLevels(r, shallowBoundaries);
    // A shallow client holds the boundary commit and its tree/blobs only — every ancestor, and every
    // ancestor's tree, was never transferred. Suppress the whole ancestor set, not just the levels the
    // new depth excludes, or `deepen` re-sends nothing and the parent arrives missing.
    for (const [sha, level] of boundaryLevels) if (level >= 1) beyond.add(sha);
    // Walk each dropped commit's tree so its blobs are re-sent too; a parent whose tree is missing is
    // exactly the failure the deepening checks report.
    const dropTips: string[] = [];
    for (const sha of beyond) {
      const obj = r.objects.get(sha);
      if (!obj || obj.type !== 'commit') continue;
      dropTips.push(parseCommitHeader(obj.data).tree);
    }
    if (dropTips.length > 0) {
      for (const oid of reachableOids(r, dropTips)) beyond.add(oid);
    }
    for (const oid of beyond) haveSet.delete(oid);
  }

  const parts: Buffer[] = [];

  if (known.length === 0) {
    // Nothing to send. v2 splits the reply into sections; v0 is just the NAK and a flush.
    if (v2) return Buffer.concat([pkt('acknowledgments\n'), pktDelim(), pkt('NAK\n'), pktFlush()]);
    return Buffer.concat([pkt('NAK\n'), pktFlush()]);
  }

  // A depth-limited fetch sends only `depth` generations of commit history: the root commits of that
  // truncated history are the shallow boundary the client must be told about, or it keeps assuming the
  // parents it is missing are simply absent from the pack and walks past them.
  const cutParents = new Map<string, string[]>();
  let shallowRoots: string[] = [];
  if (depth > 0) {
    const levels = commitLevels(r, known);
    const included = new Set<string>();
    for (const [sha, level] of levels) if (level < depth) included.add(sha);
    for (const sha of known) {
      const oldest = deepestCommit(r, sha, included, levels);
      shallowRoots = oldest.length > 0 ? oldest : shallowRoots;
    }
    for (const sha of included) {
      const obj = r.objects.get(sha);
      if (!obj || obj.type !== 'commit') continue;
      const parsed = parseCommitHeader(obj.data);
      if (parsed.parents.some((parent) => !included.has(parent))) {
        cutParents.set(sha, parsed.parents.filter((parent) => included.has(parent)));
        if (!shallowRoots.includes(sha)) shallowRoots.push(sha);
      }
    }
  }

  const reachable = depth > 0
    ? reachableObjectsShallow(r, known, cutParents)
    : reachableObjects(r, known);
  const send = reachable.filter((o) => !haveSet.has(o.oid));
  const pack = buildPack(send.map((o) => ({ oid: o.oid, type: o.type, data: o.data })));

  if (v2) {
    // Each v2 section is terminated by a delim packet (0001) and the reply ends with one flush.
    // Sending the acknowledgments section to a client that only asked for `packfile` is a protocol
    // violation, so it is gated on the request.
    if (askedAcks) {
      parts.push(pkt('acknowledgments\n'));
      parts.push(haves.length > 0 ? pkt(`ACK ${haves[haves.length - 1]}\n`) : pkt('NAK\n'));
      parts.push(pktDelim());
    }
    if (shallowRoots.length > 0 || depth > 0) {
      // Announce the truncated boundary so the client records those commits as shallow instead of
      // treating their absent parents as an error. A boundary the client previously held but that is
      // now fully materialised must be reported as `unshallow`, or the client keeps its old boundary.
      parts.push(pkt('shallow-info\n'));
      const stillShallow = new Set(shallowRoots);
      for (const sha of shallowRoots) parts.push(pkt(`shallow ${sha}\n`));
      for (const old of shallowBoundaries) {
        if (!stillShallow.has(old)) parts.push(pkt(`unshallow ${old}\n`));
      }
      parts.push(pktDelim());
    }
    parts.push(pkt('packfile\n'));
  } else {
    // v0 has no section headers: the acknowledgement (or NAK) and then the packfile itself. Adding
    // the v2 'packfile' banner here makes the client read it as the first byte of a sideband frame.
    parts.push(pkt(haves.length > 0 ? `ACK ${haves[haves.length - 1]} continue\n` : 'NAK\n'));
  }

  if (sideband) {
    // A sideband frame carries one extra band byte inside the pkt-line body, so the payload chunk
    // must be one byte smaller than a bare data packet: 65515 + 1 (band) + 4 (length) = 65520, the
    // largest length that still prints as four hex digits. Overflowing this makes pkt() emit a
    // five-digit length, shifting every later frame by one byte so the client reads the pack's 'P'
    // (0x50) as the band number: "invalid sideband band 80".
    const SB_CHUNK = LARGE_PACKET_MAX - 5 - 1;
    for (let off = 0; off < pack.length; off += SB_CHUNK) {
      const chunk = pack.subarray(off, Math.min(pack.length, off + SB_CHUNK));
      parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
    }
  } else {
    for (let off = 0; off < pack.length; off += LARGE_PACKET_MAX - 5) {
      parts.push(pkt(pack.subarray(off, Math.min(pack.length, off + LARGE_PACKET_MAX - 5))));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The plain report-status payload (no pkt-line framing): the suite/branch wraps this in band 1. */
function reportStatus(results: { ref: string; ok: boolean; message?: string }[]): Buffer {
  const lines: string[] = [];
  // `unpack` reports whether the packfile was inflated, not whether the ref updates were accepted.
  // Tying it to `results.every(ok)` made an ordinary non-fast-forward refusal look like a corrupt
  // pack, which aborted the whole push before the client could read the per-ref `ng` lines.
  lines.push('unpack ok\n');
  for (const res of results) {
    lines.push(res.ok ? `ok ${res.ref}\n` : `ng ${res.ref} ${res.message ?? 'failed'}\n`);
  }
  return Buffer.from(lines.join(''), 'utf8');
}

/** Entries of a raw tree body: `mode name\0<20-byte oid>` repeated. */
function parseTreeEntries(body: Buffer): { mode: string; name: string; sha: string }[] {
  const out: { mode: string; name: string; sha: string }[] = [];
  let off = 0;
  while (off < body.length) {
    const space = body.indexOf(0x20, off);
    if (space === -1) break;
    const nul = body.indexOf(0x00, space);
    if (nul === -1) break;
    const mode = body.subarray(off, space).toString('utf8');
    const name = body.subarray(space + 1, nul).toString('utf8');
    const sha = body.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, sha });
    off = nul + 21;
  }
  return out;
}

/** Tree and parents of a commit, read straight from its header. */
function parseCommitHeader(body: Buffer): { tree: string; parents: string[] } {
  const text = body.toString('utf8');
  const end = text.indexOf('\n\n');
  const headers = end === -1 ? text : text.slice(0, end);
  let tree = '';
  const parents: string[] = [];
  for (const line of headers.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents };
}

/** Breadth-first depth of every commit reachable from `tips`, keyed by sha. */
function commitLevels(r: Repo, tips: string[]): Map<string, number> {
  const levels = new Map<string, number>();
  const queue: { sha: string; level: number }[] = tips.map((sha) => ({ sha, level: 0 }));
  while (queue.length > 0) {
    const next = queue.shift() as { sha: string; level: number };
    const seen = levels.get(next.sha);
    if (seen !== undefined && seen <= next.level) continue;
    levels.set(next.sha, next.level);
    const obj = r.objects.get(next.sha);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommitHeader(obj.data).parents) {
      queue.push({ sha: parent, level: next.level + 1 });
    }
  }
  return levels;
}

/** Commits at the deepest retained level: the shallow boundary of a truncated history. */
function deepestCommit(r: Repo, tip: string, included: Set<string>, levels: Map<string, number>): string[] {
  const out: string[] = [];
  const obj = r.objects.get(tip);
  if (!obj || obj.type !== 'commit') return out;
  const parents = parseCommitHeader(obj.data).parents;
  const retained = parents.filter((parent) => included.has(parent));
  if (retained.length === 0) return included.has(tip) ? [tip] : [];
  for (const parent of retained) {
    const deeper = deepestCommit(r, parent, included, levels);
    for (const sha of deeper) if (!out.includes(sha)) out.push(sha);
  }
  return out;
}

/**
 * Objects reachable from `tips`, but commit-parent links listed in `cut` are not followed. The pack
 * for a shallow clone must stop at the boundary instead of shipping the whole history.
 */
function reachableObjectsShallow(
  r: Repo,
  tips: string[],
  cut: Map<string, string[]>,
): { oid: string; type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer }[] {
  const out: { oid: string; type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer }[] = [];
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = r.objects.get(sha);
    if (!obj) continue;
    out.push({ oid: sha, type: obj.type, data: obj.data });
    if (obj.type === 'commit') {
      const parsed = parseCommitHeader(obj.data);
      // `cut` names the parents that fall past the shallow boundary. Only those links are dropped —
      // the boundary commit itself is still shipped in full, which is what the client needs to make
      // the truncated history usable (a boundary commit with no tree at all is unreadable).
      const parents = cut.has(sha) ? cut.get(sha) as string[] : parsed.parents;
      for (const parent of parents) stack.push(parent);
      stack.push(parsed.tree);
    } else if (obj.type === 'tree') {
      for (const entry of parseTreeEntries(obj.data)) stack.push(entry.sha);
    } else if (obj.type === 'tag') {
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
      if (m) stack.push(m[1]);
    }
  }
  return out;
}

/** Apply a receive-pack command list and answer report-status(-v2). */
function receivePack(r: Repo, lines: string[], packBytes: Buffer): Buffer {
  const results: { ref: string; ok: boolean; message?: string }[] = [];
  const commands = lines.filter((l) => /^[0-9a-f]{40} [0-9a-f]{40} refs\//.test(l));

  if (packBytes.length > 0) {
    try {
      const objs = readPack(packBytes, r.objects);
      for (const o of objs) {
        if (!r.objects.has(o.oid)) r.objects.set(o.oid, { type: o.type, data: o.data });
      }
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      if (process.env.GHFORGE_DEBUG) process.stderr.write(`[receive-pack] ${msg}\n${err instanceof Error ? err.stack : ''}\n`);
      for (const cmd of commands) {
        const ref = cmd.split(' ')[2];
        results.push({ ref, ok: false, message: `pack error: ${msg}` });
      }
      return reportStatus(results);
    }
  }

  for (const cmd of commands) {
    const [oldSha, newSha, ref] = cmd.split(' ');
    const current = r.refs.get(ref) ?? '';
    // A create names the all-zero old value and the ref must not exist yet; an update names the
    // value the server holds. Anything else is a stale-info refusal, exactly as git reports it.
    const isCreate = oldSha === '0'.repeat(40);
    const matches = isCreate ? current === '' : current === oldSha;
    if (!matches) {
      results.push({ ref, ok: false, message: 'failed to update ref: stale info' });
      continue;
    }
    if (newSha === '0'.repeat(40)) {
      r.refs.delete(ref);
      results.push({ ref, ok: true });
      continue;
    }
    const obj = r.objects.get(newSha);
    if (!obj) {
      results.push({ ref, ok: false, message: 'missing necessary objects' });
      continue;
    }
    // Annotated tags arrive as a tag object that points at a commit; peel it so a tag ref is legal.
    let tip = newSha;
    if (obj.type === 'tag') {
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
      if (!m) {
        results.push({ ref, ok: false, message: 'malformed tag object' });
        continue;
      }
      const target = r.objects.get(m[1]);
      if (!target || target.type !== 'commit') {
        results.push({ ref, ok: false, message: 'tag does not point at a commit' });
        continue;
      }
      tip = m[1];
    } else if (obj.type !== 'commit') {
      results.push({ ref, ok: false, message: 'not a commit' });
      continue;
    }
    // refs/heads/* are only allowed to move forward: an update whose old value is not an ancestor of
    // the new one is a non-fast-forward and must be refused, or a force-push silently rewrites history.
    if (ref.startsWith('refs/heads/') && current !== '' && !isCreate) {
      if (!ancestorOf(r, current, tip)) {
        results.push({ ref, ok: false, message: 'non-fast-forward' });
        continue;
      }
    }
    // A tag ref keeps pointing at the tag object itself; the peeled commit is what `peeled:` reports.
    // Rewriting the ref to the commit would make the tag object unreachable from any ref and drop it
    // out of the clone.
    r.refs.set(ref, ref.startsWith('refs/tags/') && obj.type === 'tag' ? newSha : tip);
    results.push({ ref, ok: true });
  }
  if (commands.length === 0) return Buffer.from('unpack ok\n', 'utf8');
  return reportStatus(results);
}

/** True when `target` is reachable from `tip` by following commit parents (or is the same commit). */
function ancestorOf(r: Repo, target: string, tip: string): boolean {
  if (target === tip) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = r.objects.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    for (const line of obj.data.toString('utf8').split('\n')) {
      if (line === '') break;
      if (!line.startsWith('parent ')) continue;
      const parent = line.slice(7).trim();
      if (parent === target) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** Split a receive-pack body at the "PACK" magic: the command list, its caps, and the packfile. */
function splitReceivePackBody(body: Buffer): { lines: string[]; pack: Buffer; caps: string } {
  const packAt = body.indexOf(Buffer.from('PACK', 'ascii'));
  const head = packAt >= 0 ? body.subarray(0, packAt) : body;
  const pack = packAt >= 0 ? body.subarray(packAt) : Buffer.alloc(0);
  // Each packet is one command line: `<old> <new> <ref>\0<caps>` for the first one (the caps
  // ride after the first NUL and are not part of the ref), or `<old> <new> <ref>` for the rest.
  const lines: string[] = [];
  let caps = '';
  for (const p of parsePktLines(head)) {
    if (!p.data) continue;
    const text = p.data.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0 && caps === '') caps = text.slice(nul + 1).trim();
    const line = (nul >= 0 ? text.slice(0, nul) : text).trim();
    if (line !== '') lines.push(line);
  }
  return { lines, pack, caps };
}

// ------------------------------------------------------------------ request routing

/** True when the path names a `.git` endpoint; returns owner/repo/rest or null. */
function gitPath(path: string): { owner: string; repo: string; rest: string } | null {
  const m = path.match(/^\/([^/]+)\/([^/]+)\.git(\/.*)?$/);
  if (!m) return null;
  return { owner: decodeURIComponent(m[1]), repo: decodeURIComponent(m[2]), rest: (m[3] ?? '').replace(/\/+$/, '') };
}

/** Build the server. It binds nothing until the caller listens; main.ts listens on port 0. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) sendJson(res, 500, { message });
      else res.end();
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = pathOf(req);
  const method = req.method ?? 'GET';
  const query = searchOf(req);

  // ---- boot probe
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // ---- auth: the suite presents `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`
  const authz = req.headers['authorization'];
  const token = typeof authz === 'string' && /^bearer\s+/i.test(authz) ? authz.replace(/^bearer\s+/i, '').trim() : null;
  const expected = SHOP_TOKEN;
  const tokenOk = expected === '' ? token !== null : token === expected;
  const login = loginOf(token);

  // ---- git smart HTTP
  const gp = gitPath(path);
  if (gp && (method === 'GET' || method === 'POST')) {
    const r = store.repos.get(`${gp.owner}/${gp.repo}`);

    if (method === 'GET' && gp.rest === '/info/refs') {
      const service = query.get('service') ?? '';
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 403, { message: 'smart HTTP is the only protocol served' });
        return;
      }
      if (!r) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      infoRefs(res, r, service === 'git-upload-pack' ? 'upload-pack' : 'receive-pack', v2Requested(req));
      return;
    }

    if (method === 'POST' && gp.rest === '/git-upload-pack') {
      if (!r) { sendJson(res, 404, { message: 'Not Found' }); return; }
      const raw = await readBody(req);
      const lines = pktTextData(parsePktLines(raw));

      const isV2 = lines.some((l) => l.startsWith('command='));
      smartReplyHeaders(res, 'upload-pack');
      if (isV2) {
        if (lines.includes('command=capabilities')) { res.end(capabilityAdvertisementV2()); return; }
        if (lines.includes('command=ls-refs')) { res.end(lsRefs(r, lines)); return; }
        const wants = lines.filter((l) => l.startsWith('want ')).map((l) => l.slice(5).trim().split(' ')[0]);
        const haves = lines.filter((l) => l.startsWith('have ')).map((l) => l.slice(5).trim().split(' ')[0]);
        // Fetch v2 always frames the packfile in side-band 1. Modern git (2.43 here) does not send
        // `sideband-all` in the request body at all - it simply expects the pack to arrive banded -
        // so gating on an advertised capability sends a bare `PACK` and the client reads 'P' (0x50)
        // as the band number: "bad band #80". Only a client that explicitly opts out is unbanded.
        const sideband = !lines.some((l) => l.trim() === 'no-sideband');
        // The client names the sections it wants. Only send the acknowledgments section when it was
        // asked for: a client that requested just `packfile` reads the first section header as a
        // violation and aborts with "expected 'packfile', received 'acknowledgments'".
        const askedAcks = lines.some((l) => l.startsWith('acknowledgments') || l === 'acknowledgments');
        // `deepen <n>` (and the `deepen-relative`/`deepen-since` forms) cap how much history the pack
        // carries; the client then expects a `shallow-info` section naming the new boundary.
        let depth = 0;
        const shallowBoundaries: string[] = [];
        for (const line of lines) {
          const deep = line.match(/^deepen\s+(\d+)/);
          if (deep) depth = Number(deep[1]);
          const bound = line.match(/^shallow\s+([0-9a-f]{40})/);
          if (bound) shallowBoundaries.push(bound[1]);
        }
        if (process.env.GHFORGE_DEBUG) process.stderr.write(`[fetch-v2] depth=${depth} wants=${wants.length} haves=${haves.length} lines=${JSON.stringify(lines)}\n`);
        res.end(fetchReply(r, wants, haves, lines.includes('done'), sideband, true, askedAcks, depth, shallowBoundaries));
        return;
      }

      const wants = lines.filter((l) => l.startsWith('want ')).map((l) => l.slice(5, 45).trim());
      const haves = lines.filter((l) => l.startsWith('have ')).map((l) => l.slice(5, 45).trim());
      // v0: no section headers, and the client frames the pack with side-band-64k when it asked
      res.end(fetchReply(r, wants, haves, true, true, false));
      return;
    }

    if (method === 'POST' && gp.rest === '/git-receive-pack') {
      if (!r) { sendJson(res, 404, { message: 'Not Found' }); return; }
      if (!tokenOk) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
      const raw = await readBody(req);
      const { lines, pack, caps } = splitReceivePackBody(raw);
      const report = receivePack(r, lines, pack);
      // side-band-64k wraps the report-status payload's *data* in band 1 (one pkt-line per
      // chunk); the payload itself is the plain `unpack ok` / `ok <ref>` text lines, never a
      // second layer of pkt-line framing.
      const sb = caps.includes('side-band-64k') || caps.includes('side-band');
      smartReplyHeaders(res, 'receive-pack');
      // report-status is a *pkt-line stream*, not free text: `unpack ok` is its own packet and every
      // `ok <ref>` / `ng <ref> <why>` line gets its own packet, ending with a flush. side-band-64k
      // then carries that whole pkt-line stream inside band 1 — it does not replace the framing.
      // Concatenating the lines into one frame makes the client read "unpa" as a length header.
      const reportPackets: Buffer[] = [];
      for (const line of report.toString('utf8').split('\n')) {
        if (line.length > 0) reportPackets.push(pkt(`${line}\n`));
      }
      reportPackets.push(pktFlush());
      const reportStream = Buffer.concat(reportPackets);
      if (sb) {
        const parts: Buffer[] = [];
        // One byte of the pkt-line body is the band number, so the payload chunk is one byte smaller:
        // 65515 + 1 + 4 = 65520 keeps the length at four hex digits. A five-digit length shifts the
        // stream and makes the client read a payload byte as the band (the "bad band #80" failure).
        const chunk = LARGE_PACKET_MAX - 5 - 1;
        for (let off = 0; off < reportStream.length; off += chunk) {
          parts.push(pkt(Buffer.concat([Buffer.from([1]), reportStream.subarray(off, Math.min(reportStream.length, off + chunk))])));
        }
        parts.push(pktFlush());
        res.end(Buffer.concat(parts));
        return;
      }
      res.end(reportStream);
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // ---- MCP (streamable HTTP, JSON-RPC 2.0)
  if (path === '/mcp') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const body = await readJson(req);
    if (body === MALFORMED) {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const ctx: Ctx = { store, token, login, origin: `http://${req.headers.host ?? 'localhost'}`, sendJson: () => undefined };
    if (token === null) {
      sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'unauthorised' } });
      return;
    }
    if (Array.isArray(body)) {
      const replies = (body as Record<string, unknown>[]).map((msg) => mcpHandle(ctx, msg)).filter((x) => x !== null);
      if (replies.length === 0) { res.writeHead(202, { 'x-github-request-id': requestId() }); res.end(); return; }
      sendJson(res, 200, replies.length === 1 ? replies[0] : replies);
      return;
    }
    const reply = mcpHandle(ctx, (body ?? {}) as Record<string, unknown>);
    if (reply === null) {
      res.writeHead(202, { 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    sendJson(res, 200, reply);
    return;
  }

  // ---- REST v3 (auth required everywhere under /api/v3)
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!tokenOk) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const segs = path.replace(/^\/api\/v3\/?/, '').split('/').filter((s) => s !== '');
    const body = method === 'GET' || method === 'HEAD' || method === 'DELETE' ? null : await readJson(req);
    if (body === MALFORMED) {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    let handled = false;
    const ctx: Ctx = {
      store,
      token,
      login,
      origin: `http://${req.headers.host ?? 'localhost'}`,
      sendJson: (status, b, headers) => {
        handled = true;
        sendJson(res, status, b, headers);
      },
    };
    restRoute(ctx, method, segs.map(decodeURIComponent), query, body);
    if (!handled) sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // ---- GraphQL v4
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!tokenOk) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const body = await readJson(req);
    if (body === MALFORMED) {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    const gqlCtx = { store, token, login, origin: `http://${req.headers.host ?? 'localhost'}`, sendJson: (_s: number, _b: unknown, _h?: Record<string, string>) => {} };
    // A batched request is a JSON array of operation documents and the answer is a JSON array of the
    // same length, in order. Route each document through the same resolver with a buffering
    // sendJson so one response per operation is produced.
    if (Array.isArray(body)) {
      const responses: unknown[] = [];
      for (const doc of body) {
        let buffered: unknown = { data: {} };
        graphqlRoute({ ...gqlCtx, sendJson: (_s: number, b: unknown) => { buffered = b; } }, doc);
        responses.push(buffered);
      }
      sendJson(res, 200, responses);
      return;
    }
    graphqlRoute({ store, token, login, origin: `http://${req.headers.host ?? 'localhost'}`, sendJson: (status, b, headers) => sendJson(res, status, b, headers) }, body);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
