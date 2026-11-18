// rest.ts — the REST v3 surface: repositories, branches, commits, contents, labels, issues,
// comments and pull requests, in GitHub's shapes. Every handler answers JSON with a `message`
// on errors; the store (store.ts) is the only state. The shape builders are shared with the
// MCP tools, which return the same objects.

import {
  VIEWER,
  ZERO_OID,
  allocDbId,
  allocCommentId,
  blobAtPath,
  branchTip,
  commitChanges,
  commitTree,
  createIssue,
  createPull,
  createRepo,
  deleteRepo,
  diffTrees,
  findRepo,
  getObject,
  listRepos,
  mergeBase,
  mergePull,
  nowIso,
  parseCommit,
  parseTree,
  pullMergePreview,
  repoKey,
  repos,
  type Issue,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';

export interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface RestContext {
  method: string;
  /** Path segments after /api/v3, percent-decoded. */
  segments: string[];
  query: URLSearchParams;
  body: Record<string, unknown> | null;
  /** Absolute origin of this server (http://host) for Link headers. */
  origin: string;
  /** The request path (for Link headers). */
  path: string;
}

function err(status: number, message: string): HttpError {
  return new HttpError(status, message);
}

function bodyString(body: Record<string, unknown> | null, key: string): string | undefined {
  const value = body?.[key];
  return typeof value === 'string' ? value : undefined;
}

function bodyBool(body: Record<string, unknown> | null, key: string): boolean | undefined {
  const value = body?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

// ---------------------------------------------------------------------------
// JSON shapes
// ---------------------------------------------------------------------------

export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: Buffer.from(`User:${VIEWER.id}`).toString('base64'),
    type: 'User',
    name: VIEWER.name,
    email: VIEWER.email,
    site_admin: false,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    created_at: nowIso(),
    updated_at: nowIso(),
    pushed_at: nowIso(),
    homepage: '',
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    license: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: Buffer.from(`Label:${label.id}`).toString('base64'),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.dbId,
    node_id: Buffer.from(`Issue:${repo.id}:${issue.number}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    user: userJson(),
    labels: issue.labels
      .map((name) => repo.labels.get(name))
      .filter((label): label is Label => label !== undefined)
      .map(labelJson),
    state: issue.state,
    locked: false,
    comments: issue.comments.length,
    created_at: nowIso(),
    updated_at: nowIso(),
    closed_at: issue.state === 'closed' ? nowIso() : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function commentJson(id: number, body: string): Record<string, unknown> {
  return {
    id,
    node_id: Buffer.from(`IssueComment:${id}`).toString('base64'),
    body,
    user: userJson(),
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headRef) ?? ZERO_OID;
  const baseSha = branchTip(repo, pull.baseRef) ?? ZERO_OID;
  const refJson = (ref: string, sha: string): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userJson(),
    repo: repoJson(repo),
  });
  return {
    id: pull.dbId,
    node_id: Buffer.from(`PullRequest:${repo.id}:${pull.number}`).toString('base64'),
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(),
    labels: [],
    created_at: nowIso(),
    updated_at: nowIso(),
    closed_at: pull.state === 'closed' ? nowIso() : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: pull.state === 'open' ? pullMergePreview(repo, pull).conflicts.length === 0 : null,
    draft: false,
    head: refJson(pull.headRef, headSha),
    base: refJson(pull.baseRef, baseSha),
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function identJson(line: string): Record<string, unknown> {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: '', email: '', date: nowIso() };
  return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
}

export function commitJson(sha: string): Record<string, unknown> | null {
  const object = getObject(sha);
  if (object === undefined || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  return {
    sha,
    node_id: Buffer.from(`Commit:${sha}`).toString('base64'),
    commit: {
      author: identJson(commit.author),
      committer: identJson(commit.committer),
      message: commit.message.replace(/\n$/, ''),
      tree: { sha: commit.tree },
      comment_count: 0,
    },
    author: null,
    committer: null,
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pagination(query: URLSearchParams): { page: number; perPage: number } {
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  return { page, perPage };
}

function paged<T>(ctx: RestContext, items: readonly T[]): { slice: T[]; headers: Record<string, string> } {
  const { page, perPage } = pagination(ctx.query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  if (page < totalPages || page > 1) {
    const url = (target: number): string => {
      const params = new URLSearchParams(ctx.query);
      params.set('per_page', String(perPage));
      params.set('page', String(target));
      return `<${ctx.origin}${ctx.path}?${params.toString()}>`;
    };
    const links: string[] = [];
    if (page < totalPages) {
      links.push(`${url(page + 1)}; rel="next"`);
      links.push(`${url(totalPages)}; rel="last"`);
    }
    if (page > 1) {
      links.push(`${url(page - 1)}; rel="prev"`);
      links.push(`${url(1)}; rel="first"`);
    }
    if (links.length > 0) headers.link = links.join(', ');
  }
  return { slice, headers };
}

function requireRepo(owner: string, name: string): Repo {
  const repo = findRepo(owner, name);
  if (repo === undefined) throw err(404, 'Not Found');
  return repo;
}

/** Resolve a ref parameter (branch name or commit sha) to a commit oid. */
function resolveCommit(repo: Repo, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') return branchTip(repo, repo.defaultBranch);
  const byBranch = branchTip(repo, ref);
  if (byBranch !== null) return byBranch;
  const byRef = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`);
  if (byRef !== undefined) return byRef;
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const object = getObject(ref);
    if (object !== undefined && object.type === 'commit') return ref;
  }
  return null;
}

interface TreeWalk {
  kind: 'file' | 'dir';
  oid: string;
}

function walkTree(treeOid: string, segments: readonly string[]): TreeWalk | null {
  if (segments.length === 0) return { kind: 'dir', oid: treeOid };
  const tree = getObject(treeOid);
  if (tree === undefined || tree.type !== 'tree') return null;
  const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[0]);
  if (entry === undefined) return null;
  if (segments.length === 1) {
    return entry.mode === '40000' ? { kind: 'dir', oid: entry.oid } : { kind: 'file', oid: entry.oid };
  }
  if (entry.mode !== '40000') return null;
  return walkTree(entry.oid, segments.slice(1));
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export function handleRest(ctx: RestContext): Reply {
  const seg = ctx.segments;
  try {
    return route(ctx, seg);
  } catch (error) {
    if (error instanceof HttpError) return { status: error.status, body: { message: error.message } };
    throw error;
  }
}

function route(ctx: RestContext, seg: string[]): Reply {
  const { method } = ctx;

  if (seg.length === 0) {
    if (method !== 'GET') throw err(404, 'Not Found');
    return {
      status: 200,
      body: {
        current_user_url: `${ctx.origin}/api/v3/user`,
        repository_url: `${ctx.origin}/api/v3/repos/{owner}/{repo}`,
        issue_search_url: `${ctx.origin}/api/v3/search/issues?q={query}`,
        emojis_url: `${ctx.origin}/api/v3/emojis`,
      },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }

  if (seg[0] === 'meta' && seg.length === 1) {
    if (method !== 'GET') throw err(404, 'Not Found');
    return {
      status: 200,
      body: {
        verifiable_password_authentication: false,
        installed_version: 'github-core-clone-1.0',
        github_services_sha: 'github-core-clone',
      },
    };
  }

  if (seg[0] === 'user' && seg.length === 1) {
    if (method !== 'GET') throw err(404, 'Not Found');
    return { status: 200, body: userJson() };
  }

  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'GET') {
      const { slice, headers } = paged(ctx, listRepos().map(repoJson));
      return { status: 200, body: slice, headers };
    }
    if (method === 'POST') return createRepository(ctx);
    throw err(404, 'Not Found');
  }

  if (seg[0] === 'repos' && seg.length >= 3) {
    const repo = requireRepo(seg[1], seg[2]);
    return routeRepo(ctx, repo, seg.slice(3));
  }

  throw err(404, 'Not Found');
}

function createRepository(ctx: RestContext): Reply {
  const name = bodyString(ctx.body, 'name');
  if (name === undefined || name === '') throw err(422, 'Repository creation failed: name is required');
  if (findRepo(VIEWER.login, name) !== undefined) {
    throw err(422, 'Repository creation failed: name already exists on this account');
  }
  const repo = createRepo(name, {
    description: bodyString(ctx.body, 'description') ?? '',
    isPrivate: bodyBool(ctx.body, 'private') ?? false,
  });
  if (ctx.body?.auto_init === true) {
    const readme = `# ${name}\n\n${repo.description}\n`;
    commitChanges(repo, repo.defaultBranch, new Map([['README.md', Buffer.from(readme, 'utf8')]]), 'Initial commit');
  }
  return { status: 201, body: repoJson(repo) };
}

function routeRepo(ctx: RestContext, repo: Repo, seg: string[]): Reply {
  const { method } = ctx;

  if (seg.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(repo) };
    if (method === 'PATCH') {
      const description = bodyString(ctx.body, 'description');
      if (description !== undefined) repo.description = description;
      const isPrivate = bodyBool(ctx.body, 'private');
      if (isPrivate !== undefined) repo.isPrivate = isPrivate;
      const name = bodyString(ctx.body, 'name');
      if (name !== undefined && name !== '' && name !== repo.name) {
        deleteRepo(repo);
        repo.name = name;
        repos.set(repoKey(repo.owner, repo.name), repo);
      }
      const defaultBranch = bodyString(ctx.body, 'default_branch');
      if (defaultBranch !== undefined && defaultBranch !== '') repo.defaultBranch = defaultBranch;
      return { status: 200, body: repoJson(repo) };
    }
    if (method === 'DELETE') {
      deleteRepo(repo);
      return { status: 204, body: null };
    }
    throw err(404, 'Not Found');
  }

  if (seg[0] === 'branches') {
    if (seg.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return { status: 200, body: branches };
    }
    if (seg.length >= 2 && method === 'GET') {
      const branch = seg.slice(1).join('/');
      const tip = branchTip(repo, branch);
      if (tip === null) throw err(404, 'Branch not found');
      return { status: 200, body: { name: branch, commit: commitJson(tip), protected: false } };
    }
    throw err(404, 'Not Found');
  }

  if (seg[0] === 'commits' && seg.length === 1) {
    if (method !== 'GET') throw err(404, 'Not Found');
    const start = resolveCommit(repo, ctx.query.get('sha') ?? undefined);
    if (start === null) return { status: 200, body: [] };
    const seen = new Set<string>();
    const ordered: string[] = [];
    const queue = [start];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      ordered.push(oid);
      const object = getObject(oid);
      if (object !== undefined && object.type === 'commit') queue.push(...parseCommit(object.data).parents);
    }
    const { slice, headers } = paged(ctx, ordered);
    return { status: 200, body: slice.map((sha) => commitJson(sha)).filter((entry) => entry !== null), headers };
  }

  if (seg[0] === 'git' && seg[1] === 'refs') {
    if (seg.length === 2 && method === 'POST') {
      const ref = bodyString(ctx.body, 'ref');
      const sha = bodyString(ctx.body, 'sha');
      if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) throw err(422, 'Invalid ref or sha');
      if (getObject(sha) === undefined) throw err(422, 'Invalid sha');
      if (repo.refs.has(ref)) throw err(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return { status: 201, body: { ref, node_id: '', object: { sha, type: 'commit' } } };
    }
    if (seg.length >= 3 && method === 'GET') {
      const ref = seg.slice(2).join('/');
      const full = ref.startsWith('refs/') ? ref : `refs/${ref}`;
      const oid = repo.refs.get(full);
      if (oid === undefined) throw err(404, 'Not Found');
      const object = getObject(oid);
      return { status: 200, body: { ref: full, node_id: '', object: { sha: oid, type: object?.type ?? 'commit' } } };
    }
    throw err(404, 'Not Found');
  }

  if (seg[0] === 'contents') return routeContents(ctx, repo, seg.slice(1).join('/'));
  if (seg[0] === 'labels') return routeLabels(ctx, repo, seg.slice(1));
  if (seg[0] === 'issues') return routeIssues(ctx, repo, seg.slice(1));
  if (seg[0] === 'pulls') return routePulls(ctx, repo, seg.slice(1));

  throw err(404, 'Not Found');
}



// ---------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------

function routeContents(ctx: RestContext, repo: Repo, path: string): Reply {
  const { method } = ctx;
  if (method === 'GET') {
    const ref = ctx.query.get('ref') ?? undefined;
    const commit = resolveCommit(repo, ref);
    if (commit === null) throw err(404, 'Not Found');
    const tree = commitTree(commit);
    if (tree === null) throw err(404, 'Not Found');
    const segments = path === '' ? [] : path.split('/');
    const found = walkTree(tree, segments);
    if (found === null) throw err(404, 'Not Found');
    if (found.kind === 'file') {
      const blob = getObject(found.oid);
      if (blob === undefined) throw err(404, 'Not Found');
      const name = segments[segments.length - 1] ?? '';
      return {
        status: 200,
        body: {
          type: 'file',
          encoding: 'base64',
          size: blob.data.length,
          name,
          path,
          content: blob.data.toString('base64'),
          sha: found.oid,
        },
      };
    }
    const dirTree = getObject(found.oid);
    if (dirTree === undefined || dirTree.type !== 'tree') throw err(404, 'Not Found');
    const entries = parseTree(dirTree.data).map((entry) => {
      const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
      const child = getObject(entry.oid);
      return {
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: childPath,
        sha: entry.oid,
        size: entry.mode === '40000' ? 0 : (child?.data.length ?? 0),
      };
    });
    return { status: 200, body: entries };
  }

  if (method === 'PUT') {
    const message = bodyString(ctx.body, 'message');
    const contentB64 = bodyString(ctx.body, 'content');
    if (message === undefined || contentB64 === undefined) throw err(422, 'Invalid request: message and content are required');
    const content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    const branch = bodyString(ctx.body, 'branch') ?? repo.defaultBranch;
    const givenSha = bodyString(ctx.body, 'sha');
    const tip = branchTip(repo, branch) ?? branchTip(repo, repo.defaultBranch);
    const tree = tip === null ? null : commitTree(tip);
    const existing = tree === null ? null : blobAtPath(tree, path);
    if (existing !== null && givenSha === undefined) throw err(422, '"sha" wasn\'t supplied');
    if (existing !== null && givenSha !== undefined && givenSha !== existing) {
      throw err(409, `${path} does not match ${givenSha}`);
    }
    if (existing === null && givenSha !== undefined) throw err(422, 'Invalid sha: the file does not exist');
    const commit = commitChanges(repo, branch, new Map([[path, content]]), message);
    const blobOid = blobAtPath(commitTree(commit)!, path)!;
    return {
      status: existing === null ? 201 : 200,
      body: {
        content: {
          name: path.split('/').pop() ?? path,
          path,
          sha: blobOid,
          size: content.length,
          type: 'file',
          encoding: 'base64',
        },
        commit: { sha: commit },
      },
    };
  }

  if (method === 'DELETE') {
    const message = bodyString(ctx.body, 'message');
    const givenSha = bodyString(ctx.body, 'sha');
    if (message === undefined || givenSha === undefined) throw err(422, 'Invalid request: message and sha are required');
    const branch = bodyString(ctx.body, 'branch') ?? repo.defaultBranch;
    const tip = branchTip(repo, branch);
    if (tip === null) throw err(404, 'Not Found');
    const tree = commitTree(tip);
    const existing = tree === null ? null : blobAtPath(tree, path);
    if (existing === null) throw err(404, 'Not Found');
    if (existing !== givenSha) throw err(409, `${path} does not match ${givenSha}`);
    const commit = commitChanges(repo, branch, new Map([[path, null]]), message);
    return { status: 200, body: { content: null, commit: { sha: commit } } };
  }

  throw err(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

function routeLabels(ctx: RestContext, repo: Repo, seg: string[]): Reply {
  const { method } = ctx;
  if (seg.length === 0) {
    if (method === 'GET') return { status: 200, body: [...repo.labels.values()].map(labelJson) };
    if (method === 'POST') {
      const name = bodyString(ctx.body, 'name');
      if (name === undefined || name === '') throw err(422, 'Validation Failed: name is required');
      if (repo.labels.has(name)) throw err(422, 'Validation Failed: label already exists');
      const label: Label = {
        id: allocDbId(),
        name,
        color: (bodyString(ctx.body, 'color') ?? 'ededed').replace(/^#/, ''),
        description: bodyString(ctx.body, 'description') ?? null,
      };
      repo.labels.set(name, label);
      return { status: 201, body: labelJson(label) };
    }
  }
  throw err(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// Issues and comments
// ---------------------------------------------------------------------------

export function validateLabels(repo: Repo, labels: unknown): string[] {
  if (labels === undefined || labels === null) return [];
  if (!Array.isArray(labels)) throw err(422, 'Validation Failed: labels must be an array');
  const names: string[] = [];
  for (const entry of labels) {
    const name = typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null ? String((entry as { name?: unknown }).name ?? '') : '';
    if (!repo.labels.has(name)) throw err(422, `Validation Failed: label "${name}" does not exist`);
    names.push(name);
  }
  return names;
}

function routeIssues(ctx: RestContext, repo: Repo, seg: string[]): Reply {
  const { method } = ctx;
  if (seg.length === 0) {
    if (method === 'POST') {
      const title = bodyString(ctx.body, 'title');
      if (title === undefined || title === '') throw err(422, 'Validation Failed: title is required');
      const labels = validateLabels(repo, ctx.body?.labels);
      const issue = createIssue(repo, { title, body: bodyString(ctx.body, 'body') ?? '', labels });
      return { status: 201, body: issueJson(repo, issue) };
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const direction = ctx.query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const { slice, headers } = paged(ctx, issues);
      return { status: 200, body: slice.map((issue) => issueJson(repo, issue)), headers };
    }
    throw err(404, 'Not Found');
  }

  const number = Number(seg[0]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;

  if (seg.length === 1) {
    if (issue === undefined) throw err(404, 'Not Found');
    if (method === 'GET') return { status: 200, body: issueJson(repo, issue) };
    if (method === 'PATCH') {
      const state = bodyString(ctx.body, 'state');
      if (state === 'open' || state === 'closed') issue.state = state;
      const title = bodyString(ctx.body, 'title');
      if (title !== undefined) issue.title = title;
      const body = bodyString(ctx.body, 'body');
      if (body !== undefined) issue.body = body;
      if (ctx.body?.labels !== undefined) issue.labels = validateLabels(repo, ctx.body.labels);
      return { status: 200, body: issueJson(repo, issue) };
    }
    throw err(404, 'Not Found');
  }

  if (seg.length === 2 && seg[1] === 'comments') {
    if (issue === undefined) throw err(404, 'Not Found');
    if (method === 'GET') {
      return { status: 200, body: issue.comments.map((comment) => commentJson(comment.id, comment.body)) };
    }
    if (method === 'POST') {
      const body = bodyString(ctx.body, 'body');
      if (body === undefined) throw err(422, 'Validation Failed: body is required');
      const comment = { id: allocCommentId(), body };
      issue.comments.push(comment);
      return { status: 201, body: commentJson(comment.id, comment.body) };
    }
  }

  throw err(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

function stripOwnerPrefix(ref: string): string {
  const colon = ref.indexOf(':');
  return colon === -1 ? ref : ref.slice(colon + 1);
}

export function openPull(repo: Repo, input: { title: string; body?: string; head: string; base: string }): Pull {
  const head = stripOwnerPrefix(input.head);
  const base = stripOwnerPrefix(input.base);
  if (branchTip(repo, base) === null) throw err(422, 'Validation Failed: base does not exist');
  if (branchTip(repo, head) === null) throw err(422, 'Validation Failed: head does not exist');
  if (head === base) throw err(422, 'Validation Failed: head and base are the same');
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
      throw err(422, `Validation Failed: a pull request already exists for ${head} into ${base}`);
    }
  }
  return createPull(repo, { title: input.title, body: input.body ?? '', headRef: head, baseRef: base });
}

function routePulls(ctx: RestContext, repo: Repo, seg: string[]): Reply {
  const { method } = ctx;
  if (seg.length === 0) {
    if (method === 'POST') {
      const title = bodyString(ctx.body, 'title');
      const head = bodyString(ctx.body, 'head');
      const base = bodyString(ctx.body, 'base');
      if (title === undefined || head === undefined || base === undefined) {
        throw err(422, 'Validation Failed: title, head and base are required');
      }
      const pull = openPull(repo, { title, body: bodyString(ctx.body, 'body') ?? '', head, base });
      return { status: 201, body: pullJson(repo, pull) };
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => b.number - a.number);
      const { slice, headers } = paged(ctx, pulls);
      return { status: 200, body: slice.map((pull) => pullJson(repo, pull)), headers };
    }
    throw err(404, 'Not Found');
  }

  const number = Number(seg[0]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (pull === undefined) throw err(404, 'Not Found');

  if (seg.length === 1) {
    if (method === 'GET') return { status: 200, body: pullJson(repo, pull) };
    if (method === 'PATCH') {
      const state = bodyString(ctx.body, 'state');
      if ((state === 'open' || state === 'closed') && !pull.merged) pull.state = state;
      const title = bodyString(ctx.body, 'title');
      if (title !== undefined) pull.title = title;
      const body = bodyString(ctx.body, 'body');
      if (body !== undefined) pull.body = body;
      return { status: 200, body: pullJson(repo, pull) };
    }
    throw err(404, 'Not Found');
  }

  if (seg.length === 2 && seg[1] === 'files' && method === 'GET') {
    const baseTip = branchTip(repo, pull.baseRef);
    const headTip = branchTip(repo, pull.headRef);
    if (baseTip === null || headTip === null) return { status: 200, body: [] };
    const ancestor = mergeBase(baseTip, headTip) ?? baseTip;
    const fromTree = commitTree(ancestor);
    const toTree = commitTree(headTip);
    if (fromTree === null || toTree === null) return { status: 200, body: [] };
    const files = diffTrees(fromTree, toTree).map((file) => ({
      sha: '',
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
    }));
    const { slice, headers } = paged(ctx, files);
    return { status: 200, body: slice, headers };
  }

  if (seg.length === 2 && seg[1] === 'merge' && method === 'PUT') {
    return mergePullReply(repo, pull, bodyString(ctx.body, 'merge_method'));
  }

  throw err(404, 'Not Found');
}

export function mergePullReply(repo: Repo, pull: Pull, methodRaw: string | undefined): Reply {
  if (pull.merged) throw err(405, 'Pull Request is not mergeable');
  if (pull.state !== 'open') throw err(405, 'Pull Request is not mergeable');
  const method = methodRaw === 'merge' || methodRaw === 'rebase' ? methodRaw : 'squash';
  const outcome = mergePull(repo, pull, method);
  if ('conflict' in outcome) throw err(405, 'Pull Request is not mergeable: merge conflict');
  return {
    status: 200,
    body: { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' },
  };
}
