# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/FayBZ77/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/FayBZ77/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process, standard library only: git smart-HTTP (protocol v2 ls-refs/fetch with shallow and deepen, v0 receive-pack with report-status), the REST v3 surface (repositories, branches, commits, contents, labels, issues, comments, pull requests, merges), GraphQL v4 (the documents `gh` sends, plus the create/close/merge mutations), and an MCP endpoint (`server/discover`, tools/list, tools/call) — all over one real SHA-1 git object store, so every surface reads the same objects. It passes all 120 checks of the kit's conformance suite locally, plus the four benchmark workloads.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 node --experimental-strip-types main.ts
```

---

Entered on [make.fun](https://make.fun/?ref=4004mnbp&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards

## Implementation

- `main.ts` — the entry↔env lifecycle (bind an ephemeral port, register it, poll `/done`, exit 0), as shipped in the kit's starter.
- `app.ts` — the HTTP server: routing, bearer auth, body handling, and the git smart-HTTP endpoints.
- `store.ts` — the single source of truth: a content-addressed SHA-1 object store (blobs, trees, commits, tags) plus repositories, labels, issues and pull requests (one shared numbering counter, as on GitHub), tree-level three-way merges, and LCS line diffs. All timestamps come from `MAKEFUN_TRIAL_NOW`, never the wall clock, so a replayed request sequence reproduces identical state.
- `gitproto.ts` — pkt-lines, pack reading/writing (full objects plus ofs/ref delta resolution), v2/v0 advertisements, ls-refs with prefix filtering and peeled tags, fetch planning (haves, shallow boundaries, deepen), and push validation with per-ref fast-forward checks and sideband report-status.
- `rest.ts` — REST v3 in GitHub's shapes, with `X-GitHub-Request-Id` on every reply and JSON errors throughout.
- `graphql.ts` — a hand-rolled GraphQL parser and executor: viewer/repository/node queries, `__type` introspection, cursor-paginated issue connections, and the createIssue/closeIssue/createPullRequest/mergePullRequest/addComment mutations, with GitHub-style global ids shared with the REST `node_id`s.
- `mcp.ts` — JSON-RPC 2.0 over streamable HTTP: `server/discover` for the 2026-07-28 revision (plus the legacy `initialize` handshake), and eight tools acting on the same store.
