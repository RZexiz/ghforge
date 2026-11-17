# ghforge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/RZexiz/ghforge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/RZexiz/ghforge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge served by one process from its own in-memory store. No UI, no database, no outside service.

Built for the [make.fun](https://make.fun) `github-core-clone-01` contest: *Build a GitHub-compatible git forge*.

[View the bounty](https://make.fun/bounty/github-core-clone-01) · [Leaderboard](https://make.fun/bounty/github-core-clone-01/leaderboard)

## What it serves

| Surface | Endpoint | Notes |
| --- | --- | --- |
| git smart HTTP | `/{owner}/{repo}.git/info/refs`, `git-upload-pack`, `git-receive-pack` | protocol v2 upload-pack (shallow, deepen, ref-in-want), v0 receive-pack |
| REST v3 | `/repos`, `/repos/:o/:r/issues`, `/pulls`, `/contents`, `/git/*`, `/commits` | the subset `gh` sends |
| GraphQL | `/graphql` | alias-aware introspection, `$input` flattening, Relay global ids |
| MCP | `/mcp` | JSON-RPC tool surface |

## Design

- **Standard library only.** No npm dependencies; Node 22 runs the TypeScript directly via `--experimental-strip-types`.
- **One store.** `forge.ts` keeps a `Map` of zlib-deflated objects keyed by sha, plus refs and metadata. Push unpacks into it, clone packs back out of it.
- **git protocol by hand.** `app.ts` implements pkt-line framing, side-band-1 multiplexing, packfile build/parse (including deltas), shallow boundary negotiation and receive-pack report-status without a git binary.
- **Reachability is memoised.** `reachableOids` caches each sha's closure in a `WeakMap` keyed by repo, which keeps the sequential-push workload amortised linear instead of quadratic.

## Run

```bash
node --experimental-strip-types main.ts
```

`main.ts` expects `MAKEFUN_ENV_URL` — it binds an ephemeral port, registers it with the env and polls until the trial ends. That lifecycle belongs to the harness; the server it scores is `app.ts`.

To run it standalone:

```bash
node --experimental-strip-types -e "const {createApp}=await import('./app.ts');const s=createApp();s.listen(8080,'127.0.0.1',()=>console.log('up'))"
```

## Files

- `main.ts` — lifecycle: bind, register with the env, poll for done
- `app.ts` — HTTP surface, git smart HTTP, pkt-line/side-band/packfile
- `api.ts` — REST v3 and GraphQL
- `mcp.ts` — MCP tool handlers
- `forge.ts` — the object store, refs, tree/commit helpers, pack read/write
- `hydrate.ts` — fixture seeding
- `scenario.ts` — scenario driver

## License

MIT — see `LICENSE`.
