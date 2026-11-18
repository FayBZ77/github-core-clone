// mcp.ts — the Model Context Protocol surface at POST /mcp (JSON-RPC 2.0, streamable HTTP).
//
// Speaks the modern revision: `server/discover` answers identity, capabilities and
// supportedVersions without a handshake; `initialize` is also answered for handshake-era
// clients. The six tools the suite requires (plus get_issue and list_pull_requests) act on the
// same store as REST and return the REST shapes, so ids agree across surfaces. The tools list
// is a fixed value: two tools/list calls answer byte-identical bytes.

import {
  VIEWER,
  createIssue,
  createRepo as storeCreateRepo,
  findRepo,
  type Repo,
} from './store.ts';
import {
  HttpError,
  issueJson,
  mergePullReply,
  openPull,
  pullJson,
  repoJson,
  validateLabels,
  type Reply,
} from './rest.ts';

const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

const OWNER_PROP = { type: 'string', description: 'The repository owner (the token owner login).' };
const REPO_PROP = { type: 'string', description: 'The repository name.' };

export const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the token owner.',
    inputSchema: objectSchema(
      {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      ['name'],
    ),
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: objectSchema({ owner: OWNER_PROP, repo: REPO_PROP }, ['owner', 'repo']),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: objectSchema(
      {
        owner: OWNER_PROP,
        repo: REPO_PROP,
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      ['owner', 'repo', 'title'],
    ),
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: objectSchema(
      {
        owner: OWNER_PROP,
        repo: REPO_PROP,
        state: { type: 'string', description: 'Filter by state: open, closed or all.', enum: ['open', 'closed', 'all'] },
      },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: objectSchema(
      { owner: OWNER_PROP, repo: REPO_PROP, issue_number: { type: 'number', description: 'The issue number.' } },
      ['owner', 'repo', 'issue_number'],
    ),
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: objectSchema(
      {
        owner: OWNER_PROP,
        repo: REPO_PROP,
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      ['owner', 'repo', 'title', 'head', 'base'],
    ),
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: objectSchema(
      {
        owner: OWNER_PROP,
        repo: REPO_PROP,
        state: { type: 'string', description: 'Filter by state: open, closed or all.', enum: ['open', 'closed', 'all'] },
      },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash).',
    inputSchema: objectSchema(
      {
        owner: OWNER_PROP,
        repo: REPO_PROP,
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      ['owner', 'repo', 'pull_number'],
    ),
  },
];

// ---------------------------------------------------------------------------
// Tool implementations (the REST shapes, so ids agree across surfaces)
// ---------------------------------------------------------------------------

class ToolError extends Error {}

function requireRepo(owner: string, name: string): Repo {
  const repo = findRepo(owner, name);
  if (repo === undefined) throw new ToolError(`repository ${owner}/${name} not found`);
  return repo;
}

function argString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value === '') throw new ToolError(`missing required argument: ${key}`);
  return value;
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = argString(args, 'name');
      const existing = findRepo(VIEWER.login, repoName);
      if (existing !== undefined) return repoJson(existing);
      const repo = storeCreateRepo(repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        isPrivate: typeof args.private === 'boolean' ? args.private : false,
      });
      return repoJson(repo);
    }
    case 'get_repo': {
      return repoJson(requireRepo(argString(args, 'owner'), argString(args, 'repo')));
    }
    case 'create_issue': {
      const repo = requireRepo(argString(args, 'owner'), argString(args, 'repo'));
      const title = argString(args, 'title');
      const labels = args.labels === undefined ? [] : validateLabels(repo, args.labels);
      const issue = createIssue(repo, { title, body: typeof args.body === 'string' ? args.body : '', labels });
      return issueJson(repo, issue);
    }
    case 'list_issues': {
      const repo = requireRepo(argString(args, 'owner'), argString(args, 'repo'));
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => b.number - a.number);
      return { issues: issues.map((issue) => issueJson(repo, issue)) };
    }
    case 'get_issue': {
      const repo = requireRepo(argString(args, 'owner'), argString(args, 'repo'));
      const number = typeof args.issue_number === 'number' ? args.issue_number : Number(args.issue_number);
      const issue = repo.issues.get(number);
      if (issue === undefined) throw new ToolError(`issue ${number} not found`);
      return issueJson(repo, issue);
    }
    case 'create_pull_request': {
      const repo = requireRepo(argString(args, 'owner'), argString(args, 'repo'));
      try {
        const pull = openPull(repo, {
          title: argString(args, 'title'),
          body: typeof args.body === 'string' ? args.body : '',
          head: argString(args, 'head'),
          base: argString(args, 'base'),
        });
        return pullJson(repo, pull);
      } catch (error) {
        if (error instanceof HttpError) throw new ToolError(error.message);
        throw error;
      }
    }
    case 'list_pull_requests': {
      const repo = requireRepo(argString(args, 'owner'), argString(args, 'repo'));
      const state = typeof args.state === 'string' ? args.state : 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => b.number - a.number);
      return { pulls: pulls.map((pull) => pullJson(repo, pull)) };
    }
    case 'merge_pull_request': {
      const repo = requireRepo(argString(args, 'owner'), argString(args, 'repo'));
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = repo.pulls.get(number);
      if (pull === undefined) throw new ToolError(`pull request ${number} not found`);
      try {
        const reply = mergePullReply(repo, pull, 'squash');
        return reply.body as Record<string, unknown>;
      } catch (error) {
        if (error instanceof HttpError) throw new ToolError(error.message);
        throw error;
      }
    }
    default:
      throw new ToolError(`unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

interface RpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function handleOne(request: RpcRequest, authed: boolean): Record<string, unknown> | null {
  const method = typeof request.method === 'string' ? request.method : '';
  const id = request.id;
  const isNotification = id === undefined || id === null;
  if (!authed) return rpcError(id, -32600, 'Unauthorized');
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((candidate) => candidate.name === toolName);
      if (tool === undefined) return rpcError(id, -32602, `unknown tool: ${toolName}`);
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const required = (tool.inputSchema.required as string[] | undefined) ?? [];
      const missing = required.filter((key) => args[key] === undefined);
      if (missing.length > 0) return rpcError(id, -32602, `missing required arguments: ${missing.join(', ')}`);
      try {
        const result = callTool(toolName, args);
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
          isError: false,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return rpcResult(id, {
          content: [{ type: 'text', text: message }],
          isError: true,
        });
      }
    }
    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

export function handleMcp(input: { method: string; body: Buffer; authed: boolean }): Reply {
  if (input.method !== 'POST') {
    return { status: 405, body: { message: 'Method Not Allowed' } };
  }
  if (!input.authed) {
    return { status: 401, body: { message: 'Unauthorized' } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.body.toString('utf8'));
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  if (Array.isArray(parsed)) {
    const results = parsed
      .map((entry) => handleOne((entry ?? {}) as RpcRequest, true))
      .filter((entry) => entry !== null);
    return { status: 200, body: results };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const result = handleOne(parsed as RpcRequest, true);
  if (result === null) return { status: 202, body: null };
  return { status: 200, body: result };
}
