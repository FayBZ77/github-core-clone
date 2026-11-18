// graphql.ts — the GraphQL v4 surface at POST /api/graphql.
//
// A small hand-rolled parser (operations, variables, aliases, inline fragments, input objects,
// enum lists) and an executor over the same store the REST and git surfaces use, so an issue
// created over GraphQL is the issue REST reads back. Global ids are the REST node_ids
// (base64 "Type:..." strings): opaque, stable, and decodable by node(id:) and the mutations.
// Unknown fields answer HTTP 200 with an `errors` array naming the field, as GitHub does.

import {
  VIEWER,
  allocCommentId,
  branchTip,
  commitTree,
  createIssue,
  diffTrees,
  findRepo,
  getObject,
  mergeBase,
  mergePull,
  nowIso,
  parseCommit,
  pullMergePreview,
  repos,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { openPull, type Reply } from './rest.ts';

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const ch = source[at];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      at += 1;
      continue;
    }
    if (ch === '#') {
      while (at < source.length && source[at] !== '\n') at += 1;
      continue;
    }
    if (source.startsWith('...', at)) {
      tokens.push({ kind: 'spread' });
      at += 3;
      continue;
    }
    if ('{}()[]:$@!|='.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      at += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', at)) {
        const end = source.indexOf('"""', at + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(at + 3, end) });
        at = end + 3;
        continue;
      }
      let value = '';
      at += 1;
      while (at < source.length && source[at] !== '"') {
        if (source[at] === '\\') {
          const esc = source[at + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'b') value += '\b';
          else if (esc === 'f') value += '\f';
          else if (esc === '/') value += '/';
          else if (esc === '\\') value += '\\';
          else if (esc === '"') value += '"';
          else if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(at + 2, at + 6), 16));
            at += 4;
          } else value += esc;
          at += 2;
        } else {
          value += source[at];
          at += 1;
        }
      }
      at += 1; // closing quote
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(at));
      if (match === null) throw new Error(`bad number at ${at}`);
      const text = match[0];
      tokens.push(text.includes('.') || /[eE]/.test(text) ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      at += text.length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(at));
      tokens.push({ kind: 'name', value: match![0] });
      at += match![0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} at ${at}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inlineFragment'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variableDefaults: Map<string, ValueNode>;
  selectionSet: SelectionNode[];
}

class Parser {
  private tokens: Token[];
  private at = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.at];
  }

  private next(): Token {
    const token = this.tokens[this.at];
    this.at += 1;
    return token;
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private expectPunct(value: string): void {
    if (!this.isPunct(value)) throw new Error(`expected ${value}`);
    this.at += 1;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, SelectionNode[]> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, variableDefaults: new Map(), selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const operation = token.value;
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        const variableDefaults = new Map<string, ValueNode>();
        if (this.isPunct('(')) this.parseVariableDefinitions(variableDefaults);
        this.skipDirectives();
        operations.push({ operation, name, variableDefaults, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragmentName = this.expectName();
        if (this.expectName() !== 'on') throw new Error('expected on in fragment definition');
        this.expectName(); // type condition
        this.skipDirectives();
        fragments.set(fragmentName, this.parseSelectionSet());
        continue;
      }
      throw new Error('unexpected token in document');
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(defaults: Map<string, ValueNode>): void {
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.skipType();
      if (this.isPunct('=')) {
        this.next();
        defaults.set(name, this.parseValue());
      }
      this.skipDirectives();
    }
    this.expectPunct(')');
  }

  private skipType(): void {
    if (this.isPunct('[')) {
      this.next();
      this.skipType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.isPunct('!')) this.next();
  }

  private skipDirectives(): void {
    while (this.isPunct('@')) {
      this.next();
      this.expectName();
      if (this.isPunct('(')) {
        this.next();
        while (!this.isPunct(')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
        this.expectPunct(')');
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.isPunct('}')) {
      const token = this.peek();
      if (token.kind === 'spread') {
        this.next();
        const nextToken = this.peek();
        if (nextToken.kind === 'name' && nextToken.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() });
        } else if (nextToken.kind === 'name') {
          selections.push({ kind: 'fragmentSpread', name: this.expectName() });
          this.skipDirectives();
        } else {
          throw new Error('bad fragment');
        }
        continue;
      }
      let alias: string | null = null;
      let name = this.expectName();
      if (this.isPunct(':')) {
        this.next();
        alias = name;
        name = this.expectName();
      }
      const args: FieldNode['args'] = [];
      if (this.isPunct('(')) {
        this.next();
        while (!this.isPunct(')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args.push({ name: argName, value: this.parseValue() });
        }
        this.expectPunct(')');
      }
      this.skipDirectives();
      const selectionSet = this.isPunct('{') ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', alias, name, args, selectionSet });
    }
    this.expectPunct('}');
    return selections;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    switch (token.kind) {
      case 'int':
        return { kind: 'int', value: token.value };
      case 'float':
        return { kind: 'float', value: token.value };
      case 'string':
        return { kind: 'string', value: token.value };
      case 'name':
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      case 'punct':
        if (token.value === '$') return { kind: 'variable', name: this.expectName() };
        if (token.value === '[') {
          const values: ValueNode[] = [];
          while (!this.isPunct(']')) values.push(this.parseValue());
          this.expectPunct(']');
          return { kind: 'list', values };
        }
        if (token.value === '{') {
          const fields: { name: string; value: ValueNode }[] = [];
          while (!this.isPunct('}')) {
            const name = this.expectName();
            this.expectPunct(':');
            fields.push({ name, value: this.parseValue() });
          }
          this.expectPunct('}');
          return { kind: 'object', fields };
        }
        break;
      default:
        break;
    }
    throw new Error('unexpected value token');
  }
}

// ---------------------------------------------------------------------------
// Schema registry (introspection + unknown-field detection)
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate',
    'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues',
    'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'url',
  ],
  Ref: ['name', 'prefix', 'target'],
  Commit: ['oid', 'message', 'committedDate', 'author'],
  GitActor: ['name', 'email', 'date'],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'author', 'repository', 'comments', 'labels',
    'createdAt', 'updatedAt', 'closedAt', 'url',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRef', 'baseRef', 'files', 'author', 'repository', 'createdAt', 'updatedAt', 'closedAt',
    'mergedAt', 'url',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequestChangedFileConnection: ['nodes', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueCommentConnection: ['nodes', 'totalCount'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  LabelConnection: ['nodes', 'totalCount'],
  Label: ['name', 'color', 'description'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType', 'specifiedByURL'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['types', 'queryType', 'mutationType'],
  Node: ['id'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'DISCUSSION', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

function typeKind(name: string): string {
  if (ENUM_VALUES[name] !== undefined) return 'ENUM';
  if (name === 'Node') return 'INTERFACE';
  return 'OBJECT';
}

// ---------------------------------------------------------------------------
// Global ids
// ---------------------------------------------------------------------------

function encodeId(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function decodeId(id: string): { type: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon === -1) return null;
    return { type: text.slice(0, colon), parts: text.slice(colon + 1).split(':') };
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: Repo): string {
  return encodeId(`Repository:${repo.id}`);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return encodeId(`Issue:${repo.id}:${issue.number}`);
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return encodeId(`PullRequest:${repo.id}:${pull.number}`);
}

function repoById(id: number): Repo | undefined {
  for (const repo of repos.values()) if (repo.id === id) return repo;
  return undefined;
}

// ---------------------------------------------------------------------------
// Domain wrappers
// ---------------------------------------------------------------------------

type Obj = { __typename: string } & Record<string, unknown>;
type Value = string | number | boolean | null | Obj | Value[] | Record<string, unknown>;

function viewerObj(): Obj {
  return { __typename: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
}

function repoObj(repo: Repo): Obj {
  return { __typename: 'Repository', repo };
}

function issueObj(repo: Repo, issue: Issue): Obj {
  return { __typename: 'Issue', repo, issue };
}

function pullObj(repo: Repo, pull: Pull): Obj {
  return { __typename: 'PullRequest', repo, pull };
}

function refObj(repo: Repo, branch: string): Obj | null {
  const tip = branchTip(repo, branch);
  if (tip === null) return null;
  return { __typename: 'Ref', name: branch, repo, tip };
}

function cursorFor(number: number): string {
  return encodeId(`cursor:${number}`);
}

function numberFromCursor(cursor: string): number | null {
  const decoded = decodeId(cursor);
  if (decoded === null || decoded.type !== 'cursor') return null;
  const number = Number(decoded.parts[0]);
  return Number.isInteger(number) ? number : null;
}

interface Page<T> {
  nodes: T[];
  hasNextPage: boolean;
  endCursor: string | null;
  startCursor: string | null;
  total: number;
}

function pageOf<T extends { number: number }>(items: readonly T[], first: number | null, after: string | null): Page<T> {
  let start = 0;
  if (after !== null) {
    const number = numberFromCursor(after);
    const index = number === null ? -1 : items.findIndex((item) => item.number === number);
    start = index === -1 ? items.length : index + 1;
  }
  const limit = first === null ? items.length : Math.max(0, first);
  const nodes = items.slice(start, start + limit);
  return {
    nodes,
    hasNextPage: start + nodes.length < items.length,
    endCursor: nodes.length > 0 ? cursorFor(nodes[nodes.length - 1].number) : null,
    startCursor: nodes.length > 0 ? cursorFor(nodes[0].number) : null,
    total: items.length,
  };
}

function pageInfoObj<T extends { number: number }>(page: Page<T>): Obj {
  return {
    __typename: 'PageInfo',
    hasNextPage: page.hasNextPage,
    hasPreviousPage: false,
    startCursor: page.startCursor,
    endCursor: page.endCursor,
  };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

class GqlError extends Error {}

interface ExecContext {
  variables: Record<string, unknown>;
  defaults: Map<string, ValueNode>;
  fragments: Map<string, SelectionNode[]>;
  errors: { message: string }[];
}

function evalValue(node: ValueNode, ctx: ExecContext): unknown {
  switch (node.kind) {
    case 'variable': {
      if (node.name in ctx.variables) return ctx.variables[node.name];
      const fallback = ctx.defaults.get(node.name);
      return fallback === undefined ? null : evalValue(fallback, ctx);
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((value) => evalValue(value, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, ctx);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = evalValue(arg.value, ctx);
  return out;
}

function pullState(pull: Pull): string {
  return pull.merged ? 'MERGED' : pull.state.toUpperCase();
}

function resolveField(obj: Obj | null, typeName: string, field: string, args: Record<string, unknown>, ctx: ExecContext): Value {
  void ctx;
  switch (typeName) {
    case 'Query': {
      if (field === 'viewer') return viewerObj();
      if (field === 'repository') {
        const repo = findRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === undefined ? null : repoObj(repo);
      }
      if (field === 'node' || field === 'nodes') {
        const id = String(args.id ?? '');
        const decoded = decodeId(id);
        if (decoded === null) return null;
        if (decoded.type === 'Repository') {
          const repo = repoById(Number(decoded.parts[0]));
          return repo === undefined ? null : repoObj(repo);
        }
        if (decoded.type === 'Issue') {
          const repo = repoById(Number(decoded.parts[0]));
          const issue = repo?.issues.get(Number(decoded.parts[1]));
          return repo !== undefined && issue !== undefined ? issueObj(repo, issue) : null;
        }
        if (decoded.type === 'PullRequest') {
          const repo = repoById(Number(decoded.parts[0]));
          const pull = repo?.pulls.get(Number(decoded.parts[1]));
          return repo !== undefined && pull !== undefined ? pullObj(repo, pull) : null;
        }
        if (decoded.type === 'User') return viewerObj();
        return null;
      }
      if (field === '__type') {
        const name = String(args.name ?? '');
        if (TYPE_FIELDS[name] === undefined && ENUM_VALUES[name] === undefined) return null;
        return { __typename: '__Type', typeName: name };
      }
      if (field === '__schema') return { __typename: '__Schema' };
      break;
    }
    case 'Mutation': {
      const input = (args.input ?? {}) as Record<string, unknown>;
      if (field === 'createIssue') {
        const decoded = decodeId(String(input.repositoryId ?? ''));
        const repo = decoded !== null && decoded.type === 'Repository' ? repoById(Number(decoded.parts[0])) : undefined;
        if (repo === undefined) throw new GqlError('repository not found');
        const issue = createIssue(repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
        return { __typename: 'CreateIssuePayload', issue: issueObj(repo, issue), clientMutationId: input.clientMutationId ?? null };
      }
      if (field === 'closeIssue') {
        const decoded = decodeId(String(input.issueId ?? ''));
        const repo = decoded !== null && decoded.type === 'Issue' ? repoById(Number(decoded.parts[0])) : undefined;
        const issue = repo?.issues.get(Number(decoded?.parts[1]));
        if (repo === undefined || issue === undefined) throw new GqlError('issue not found');
        issue.state = 'closed';
        return { __typename: 'CloseIssuePayload', issue: issueObj(repo, issue), clientMutationId: input.clientMutationId ?? null };
      }
      if (field === 'createPullRequest') {
        const decoded = decodeId(String(input.repositoryId ?? ''));
        const repo = decoded !== null && decoded.type === 'Repository' ? repoById(Number(decoded.parts[0])) : undefined;
        if (repo === undefined) throw new GqlError('repository not found');
        try {
          const pull = openPull(repo, {
            title: String(input.title ?? ''),
            body: String(input.body ?? ''),
            head: String(input.headRefName ?? ''),
            base: String(input.baseRefName ?? ''),
          });
          return { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(repo, pull), clientMutationId: input.clientMutationId ?? null };
        } catch (error) {
          throw new GqlError(error instanceof Error ? error.message : 'could not create pull request');
        }
      }
      if (field === 'mergePullRequest') {
        const decoded = decodeId(String(input.pullRequestId ?? ''));
        const repo = decoded !== null && decoded.type === 'PullRequest' ? repoById(Number(decoded.parts[0])) : undefined;
        const pull = repo?.pulls.get(Number(decoded?.parts[1]));
        if (repo === undefined || pull === undefined) throw new GqlError('pull request not found');
        const raw = String(input.mergeMethod ?? 'SQUASH').toLowerCase();
        const method = raw === 'merge' || raw === 'rebase' ? raw : 'squash';
        const outcome = mergePull(repo, pull, method);
        if ('conflict' in outcome) throw new GqlError('Pull Request is not mergeable: merge conflict');
        return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(repo, pull), clientMutationId: input.clientMutationId ?? null };
      }
      if (field === 'addComment') {
        const decoded = decodeId(String(input.subjectId ?? ''));
        const repo = decoded !== null && decoded.type === 'Issue' ? repoById(Number(decoded.parts[0])) : undefined;
        const issue = repo?.issues.get(Number(decoded?.parts[1]));
        if (repo === undefined || issue === undefined) throw new GqlError('subject not found');
        const comment = { id: allocCommentId(), body: String(input.body ?? '') };
        issue.comments.push(comment);
        const node: Obj = { __typename: 'IssueComment', repo, issue, comment };
        return {
          __typename: 'AddCommentPayload',
          commentEdge: { __typename: 'IssueCommentEdge', node, cursor: encodeId(`cursor:${comment.id}`) },
          clientMutationId: input.clientMutationId ?? null,
        };
      }
      break;
    }
    case 'User': {
      const user = obj as unknown as { login: string; id: number; name: string; email: string };
      if (field === 'login') return user.login;
      if (field === 'id') return encodeId(`User:${user.id}`);
      if (field === 'name') return user.name;
      if (field === 'email') return user.email;
      if (field === 'url') return `https://github.com/${user.login}`;
      break;
    }
    case 'Repository': {
      const repo = obj!.repo as Repo;
      switch (field) {
        case 'id':
          return repoGlobalId(repo);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return viewerObj();
        case 'description':
          return repo.description === '' ? null : repo.description;
        case 'isPrivate':
          return repo.isPrivate;
        case 'defaultBranchRef': {
          const tip = branchTip(repo, repo.defaultBranch);
          return tip === null ? null : refObj(repo, repo.defaultBranch);
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue === undefined ? null : issueObj(repo, issue);
        }
        case 'issues': {
          let issues = [...repo.issues.values()];
          const states = args.states as string[] | undefined;
          if (Array.isArray(states) && states.length > 0) {
            const wanted = states.map((state) => String(state).toLowerCase());
            issues = issues.filter((issue) => wanted.includes(issue.state));
          }
          const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
          const direction = orderBy?.direction ?? 'ASC';
          issues.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
          const page = pageOf(issues, typeof args.first === 'number' ? args.first : null, typeof args.after === 'string' ? args.after : null);
          return {
            __typename: 'IssueConnection',
            nodes: page.nodes.map((issue) => issueObj(repo, issue)),
            edges: page.nodes.map((issue) => ({ __typename: 'IssueEdge', node: issueObj(repo, issue), cursor: cursorFor(issue.number) })),
            pageInfo: pageInfoObj(page),
            totalCount: page.total,
          };
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull === undefined ? null : pullObj(repo, pull);
        }
        case 'pullRequests': {
          let pulls = [...repo.pulls.values()];
          const states = (args.states as string[] | undefined) ?? ['OPEN'];
          if (Array.isArray(states) && states.length > 0) {
            pulls = pulls.filter((pull) => states.includes(pullState(pull)));
          }
          pulls.sort((a, b) => b.number - a.number);
          const page = pageOf(pulls, typeof args.first === 'number' ? args.first : null, typeof args.after === 'string' ? args.after : null);
          return {
            __typename: 'PullRequestConnection',
            nodes: page.nodes.map((pull) => pullObj(repo, pull)),
            edges: page.nodes.map((pull) => ({ __typename: 'PullRequestEdge', node: pullObj(repo, pull), cursor: cursorFor(pull.number) })),
            pageInfo: pageInfoObj(page),
            totalCount: page.total,
          };
        }
        case 'createdAt':
        case 'updatedAt':
          return nowIso();
        case 'url':
          return `https://github.com/${repo.owner}/${repo.name}`;
      }
      break;
    }
    case 'Ref': {
      if (field === 'name') return String(obj!.name);
      if (field === 'prefix') return 'refs/heads/';
      if (field === 'target') {
        const commit = getObject(String(obj!.tip));
        if (commit === undefined) return null;
        const parsed = parseCommit(commit.data);
        return { __typename: 'Commit', oid: String(obj!.tip), message: parsed.message, repo: obj!.repo };
      }
      break;
    }
    case 'Commit': {
      if (field === 'oid') return String(obj!.oid);
      if (field === 'message') return String(obj!.message ?? '');
      if (field === 'committedDate') return nowIso();
      if (field === 'author') return { __typename: 'GitActor', name: VIEWER.name, email: VIEWER.email, date: nowIso() };
      break;
    }
    case 'GitActor': {
      if (field === 'name') return String(obj!.name);
      if (field === 'email') return String(obj!.email);
      if (field === 'date') return String(obj!.date);
      break;
    }
    case 'Issue': {
      const repo = obj!.repo as Repo;
      const issue = obj!.issue as Issue;
      switch (field) {
        case 'id':
          return issueGlobalId(repo, issue);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issue.state.toUpperCase();
        case 'body':
          return issue.body;
        case 'author':
          return viewerObj();
        case 'repository':
          return repoObj(repo);
        case 'comments':
          return {
            __typename: 'IssueCommentConnection',
            nodes: issue.comments.map((comment) => ({ __typename: 'IssueComment', repo, issue, comment })),
            totalCount: issue.comments.length,
          };
        case 'labels':
          return {
            __typename: 'LabelConnection',
            nodes: issue.labels
              .map((name) => repo.labels.get(name))
              .filter((label) => label !== undefined)
              .map((label) => ({ __typename: 'Label', name: label!.name, color: label!.color, description: label!.description })),
            totalCount: issue.labels.length,
          };
        case 'createdAt':
        case 'updatedAt':
          return nowIso();
        case 'closedAt':
          return issue.state === 'closed' ? nowIso() : null;
        case 'url':
          return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
      }
      break;
    }
    case 'PullRequest': {
      const repo = obj!.repo as Repo;
      const pull = obj!.pull as Pull;
      switch (field) {
        case 'id':
          return pullGlobalId(repo, pull);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pullState(pull);
        case 'merged':
          return pull.merged;
        case 'mergeable': {
          if (pull.state !== 'open') return 'UNKNOWN';
          return pullMergePreview(repo, pull).conflicts.length === 0 ? 'MERGEABLE' : 'CONFLICTING';
        }
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'headRef':
          return refObj(repo, pull.headRef);
        case 'baseRef':
          return refObj(repo, pull.baseRef);
        case 'files': {
          const baseTip = branchTip(repo, pull.baseRef);
          const headTip = branchTip(repo, pull.headRef);
          let files: { path: string }[] = [];
          if (baseTip !== null && headTip !== null) {
            const ancestor = mergeBase(baseTip, headTip) ?? baseTip;
            const fromTree = commitTree(ancestor);
            const toTree = commitTree(headTip);
            if (fromTree !== null && toTree !== null) {
              files = diffTrees(fromTree, toTree).map((file) => ({ path: file.filename }));
            }
          }
          const first = typeof args.first === 'number' ? args.first : files.length;
          return {
            __typename: 'PullRequestChangedFileConnection',
            nodes: files.slice(0, first).map((file) => ({ __typename: 'PullRequestChangedFile', path: file.path })),
            totalCount: files.length,
          };
        }
        case 'author':
          return viewerObj();
        case 'repository':
          return repoObj(repo);
        case 'createdAt':
        case 'updatedAt':
          return nowIso();
        case 'closedAt':
          return pull.state === 'closed' ? nowIso() : null;
        case 'mergedAt':
          return pull.mergedAt;
        case 'url':
          return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
      }
      break;
    }
    case 'PullRequestChangedFile': {
      if (field === 'path') return String(obj!.path);
      if (field === 'additions' || field === 'deletions') return 0;
      if (field === 'changeType') return 'MODIFIED';
      break;
    }
    case 'IssueComment': {
      const comment = obj!.comment as { id: number; body: string };
      if (field === 'id') return encodeId(`IssueComment:${comment.id}`);
      if (field === 'body') return comment.body;
      if (field === 'author') return viewerObj();
      if (field === 'createdAt') return nowIso();
      break;
    }
    case 'Label': {
      if (field === 'name') return String(obj!.name);
      if (field === 'color') return String(obj!.color);
      if (field === 'description') return (obj!.description as string | null) ?? null;
      break;
    }
    case '__Type': {
      const name = String(obj!.typeName);
      if (field === 'name') return name;
      if (field === 'kind') return typeKind(name);
      if (field === 'description') return null;
      if (field === 'fields') {
        const fields = TYPE_FIELDS[name];
        if (fields === undefined) return null;
        return fields.map((fieldName) => ({ __typename: '__Field', fieldName }));
      }
      if (field === 'enumValues') {
        const values = ENUM_VALUES[name];
        if (values === undefined) return null;
        return values.map((value) => ({ __typename: '__EnumValue', valueName: value }));
      }
      if (field === 'possibleTypes' || field === 'inputFields') return null;
      if (field === 'ofType' || field === 'specifiedByURL') return null;
      break;
    }
    case '__Field': {
      if (field === 'name') return String(obj!.fieldName);
      if (field === 'description') return null;
      if (field === 'args') return [];
      if (field === 'type') return null;
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      break;
    }
    case '__EnumValue': {
      if (field === 'name') return String(obj!.valueName);
      if (field === 'description') return null;
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      break;
    }
    case '__Schema': {
      if (field === 'types') return Object.keys(TYPE_FIELDS).map((name) => ({ __typename: '__Type', typeName: name }));
      if (field === 'queryType') return { __typename: '__Type', typeName: 'Query' };
      if (field === 'mutationType') return { __typename: '__Type', typeName: 'Mutation' };
      break;
    }
    default: {
      // Connection and payload wrappers carry their values directly.
      if (obj !== null && field in obj) return obj[field] as Value;
      break;
    }
  }
  return null;
}

function executeSelectionSet(obj: Obj | null, typeName: string, selections: SelectionNode[], ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const knownFields = TYPE_FIELDS[typeName];
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      const condition = selection.typeCondition;
      if (condition === null || obj === null || condition === obj.__typename || condition === 'Node') {
        Object.assign(out, executeSelectionSet(obj, obj?.__typename ?? typeName, selection.selectionSet, ctx));
      }
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && obj !== null) {
        Object.assign(out, executeSelectionSet(obj, obj.__typename, fragment, ctx));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    if (knownFields !== undefined && !knownFields.includes(selection.name)) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    let value: Value;
    try {
      value = resolveField(obj, typeName, selection.name, argsOf(selection, ctx), ctx);
    } catch (error) {
      ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(value, selection, ctx);
  }
  return out;
}

function completeValue(value: Value, field: FieldNode, ctx: ExecContext): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(entry as Value, field, ctx));
  if (typeof value === 'object') {
    const obj = value as Obj;
    if (typeof obj.__typename === 'string' && field.selectionSet !== null) {
      return executeSelectionSet(obj, obj.__typename, field.selectionSet, ctx);
    }
    return value;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

interface GraphqlRequest {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

function executeOne(request: GraphqlRequest): Record<string, unknown> {
  const query = typeof request.query === 'string' ? request.query : '';
  let document: { operations: OperationNode[]; fragments: Map<string, SelectionNode[]> };
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'parse error' }] };
  }
  if (document.operations.length === 0) return { errors: [{ message: 'no operation in document' }] };
  const operationName = typeof request.operationName === 'string' ? request.operationName : null;
  const operation = (operationName !== null ? document.operations.find((op) => op.name === operationName) : undefined) ?? document.operations[0];
  let variables: Record<string, unknown> = {};
  if (typeof request.variables === 'object' && request.variables !== null) variables = request.variables as Record<string, unknown>;
  else if (typeof request.variables === 'string') {
    try {
      variables = JSON.parse(request.variables) as Record<string, unknown>;
    } catch {
      variables = {};
    }
  }
  const ctx: ExecContext = { variables, defaults: operation.variableDefaults, fragments: document.fragments, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(null, rootType, operation.selectionSet, ctx);
  const reply: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) reply.errors = ctx.errors;
  return reply;
}

export function handleGraphql(body: Buffer): Reply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, body: { errors: [{ message: 'Problems parsing JSON' }] } };
  }
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map((entry) => executeOne((entry ?? {}) as GraphqlRequest)) };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 400, body: { errors: [{ message: 'Invalid GraphQL request' }] } };
  }
  return { status: 200, body: executeOne(parsed as GraphqlRequest) };
}
