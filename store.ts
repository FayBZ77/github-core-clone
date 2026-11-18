// store.ts — the forge's single source of truth.
//
// One content-addressed git object store (SHA-1 blobs, trees, commits, tags) backs every surface:
// the contents API writes real commits into it, git smart-HTTP reads and writes the same objects,
// and GraphQL/MCP resolve against the repositories, issues and pull requests kept beside it.
// Issues and pull requests share one per-repository numbering counter, as on GitHub.
//
// Nothing here reads the wall clock: the only "now" is the trial's fixed instant
// (MAKEFUN_TRIAL_NOW), so a replayed request sequence produces identical state.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// The seeded viewer (the token's owner). wire.ts's buildScenario() yields this
// login in every trial; the suite creates the token's repositories under it.
// ---------------------------------------------------------------------------

export interface Viewer {
  login: string;
  id: number;
  name: string;
  email: string;
}

export const VIEWER: Viewer = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

// ---------------------------------------------------------------------------
// Time: the trial's fixed now, parsed once.
// ---------------------------------------------------------------------------

const FALLBACK_NOW = '2026-01-01T00:00:00.000Z';

function parseTrialNow(): Date {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && /^\d+$/.test(raw.trim())) return new Date(asNumber);
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(FALLBACK_NOW);
}

const TRIAL_NOW = parseTrialNow();

/** The trial's fixed instant as an ISO string (every created_at/updated_at the forge reports). */
export function nowIso(): string {
  return TRIAL_NOW.toISOString();
}

/** The trial's fixed instant in epoch seconds (commit author/committer timestamps). */
export function nowEpochSec(): number {
  return Math.floor(TRIAL_NOW.getTime() / 1000);
}

/** The identity server-made commits (contents API, merges) carry. */
export function serverIdentity(): string {
  return `${VIEWER.name} <${VIEWER.email}> ${nowEpochSec()} +0000`;
}

// ---------------------------------------------------------------------------
// Git objects
// ---------------------------------------------------------------------------

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

/** The one object store, shared by every repository (content-addressed, as in git). */
export const objects = new Map<string, GitObject>();

export function putObject(type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

export function getObject(oid: string): GitObject | undefined {
  return objects.get(oid);
}

// ---------------------------------------------------------------------------
// Tree and commit codecs
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string; // '100644' | '100755' | '120000' | '40000' (tree) | '160000'
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.toString('utf8', offset, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree order: by name, with directories compared as if suffixed with '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  let tree = ZERO_OID;
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

/** Peel a tag (or return a commit) to the commit it ultimately points at; null for other types. */
export function peelToCommit(oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
      if (match === null) return null;
      current = match[1];
      continue;
    }
    return null;
  }
  return null;
}

/** The commit a ref value names, peeling annotated tags. */
export function refCommit(oid: string): string | null {
  return peelToCommit(oid);
}

/** Every object reachable from `tips` (commits walk to trees and parents; tags to their target). */
export function reachableFrom(tips: readonly string[], into: Set<string> = new Set()): Set<string> {
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (into.has(oid)) continue;
    const object = objects.get(oid);
    if (object === undefined) continue;
    into.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      const target = peelStep(object.data);
      if (target !== null) stack.push(target);
    }
  }
  return into;
}

function peelStep(tagData: Buffer): string | null {
  const match = /^object ([0-9a-f]{40})$/m.exec(tagData.toString('utf8'));
  return match === null ? null : match[1];
}

/** The tree closure of one commit (the commit's tree and everything under it), no parents. */
export function treeClosureOf(commitOid: string, into: Set<string> = new Set()): Set<string> {
  const commit = objects.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return into;
  into.add(commitOid);
  const stack = [parseCommit(commit.data).tree];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (into.has(oid)) continue;
    const object = objects.get(oid);
    if (object === undefined) continue;
    into.add(oid);
    if (object.type === 'tree') for (const entry of parseTree(object.data)) stack.push(entry.oid);
  }
  return into;
}

/** Flatten a tree into path -> blob oid (files only). */
export function flattenTree(treeOid: string, prefix = '', into: Map<string, string> = new Map()): Map<string, string> {
  const tree = objects.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return into;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(entry.oid, path, into);
    else into.set(path, entry.oid);
  }
  return into;
}

/** Rebuild a tree from a flattened path -> blob oid map. Returns the root tree oid. */
export function treeFromFlat(flat: ReadonlyMap<string, string>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, oid] of flat) {
    const segments = path.split('/');
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let child = node.dirs.get(segment);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(segment, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1], oid);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject('tree', buildTree(entries));
  };
  return build(root);
}

/** True when `ancestor` is `descendant` itself or one of its ancestors. */
export function isAncestor(ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = objects.get(oid);
    if (object !== undefined && object.type === 'commit') stack.push(...parseCommit(object.data).parents);
  }
  return false;
}

/** The best common ancestor of two commits (breadth-first from `b` into `a`'s ancestor set). */
export function mergeBase(a: string, b: string): string | null {
  const ancestorsOfA = new Set<string>();
  const stack = [a];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (ancestorsOfA.has(oid)) continue;
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    ancestorsOfA.add(oid);
    stack.push(...parseCommit(object.data).parents);
  }
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (ancestorsOfA.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = objects.get(oid);
    if (object !== undefined && object.type === 'commit') queue.push(...parseCommit(object.data).parents);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Repositories, issues, pull requests
// ---------------------------------------------------------------------------

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  id: number;
  body: string;
}

export interface Issue {
  number: number;
  dbId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
}

export interface Pull {
  number: number;
  dbId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number;
}

export const repos = new Map<string, Repo>();
let nextRepoId = 1;
let nextDbId = 1;
let nextCommentId = 1;

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function findRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

export function createRepo(name: string, options: { description?: string; isPrivate?: boolean } = {}): Repo {
  const repo: Repo = {
    id: nextRepoId,
    owner: VIEWER.login,
    name,
    description: options.description ?? '',
    isPrivate: options.isPrivate ?? false,
    defaultBranch: 'main',
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
  };
  nextRepoId += 1;
  repos.set(repoKey(repo.owner, name), repo);
  return repo;
}

export function deleteRepo(repo: Repo): void {
  repos.delete(repoKey(repo.owner, repo.name));
}

export function listRepos(): Repo[] {
  return [...repos.values()].sort((a, b) => a.id - b.id);
}

export function allocDbId(): number {
  const id = nextDbId;
  nextDbId += 1;
  return id;
}

export function allocCommentId(): number {
  const id = nextCommentId;
  nextCommentId += 1;
  return id;
}

export function createIssue(repo: Repo, input: { title: string; body?: string; labels?: string[] }): Issue {
  const issue: Issue = {
    number: repo.nextNumber,
    dbId: allocDbId(),
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: [...(input.labels ?? [])],
    comments: [],
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

export function createPull(repo: Repo, input: { title: string; body?: string; headRef: string; baseRef: string }): Pull {
  const pull: Pull = {
    number: repo.nextNumber,
    dbId: allocDbId(),
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: input.headRef,
    baseRef: input.baseRef,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** The tip commit oid of a branch, or null when the branch does not exist. */
export function branchTip(repo: Repo, branch: string): string | null {
  const oid = repo.refs.get(`refs/heads/${branch}`);
  return oid === undefined ? null : oid;
}

/** The tree oid a commit names. */
export function commitTree(commitOid: string): string | null {
  const object = objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/**
 * Commit a set of path changes (Buffer = write this blob, null = delete the path) on a branch,
 * creating the branch (and the repository's history) when it does not exist yet. When the branch
 * is missing but the repository has a default-branch tip, the new branch starts there.
 * Returns the new commit oid.
 */
export function commitChanges(repo: Repo, branch: string, changes: ReadonlyMap<string, Buffer | null>, message: string): string {
  let tip = branchTip(repo, branch);
  if (tip === null && branch !== repo.defaultBranch) tip = branchTip(repo, repo.defaultBranch);
  const baseTree = tip === null ? null : commitTree(tip);
  const flat = baseTree === null ? new Map<string, string>() : flattenTree(baseTree);
  for (const [path, content] of changes) {
    if (content === null) flat.delete(path);
    else flat.set(path, putObject('blob', content));
  }
  const tree = treeFromFlat(flat);
  const identity = serverIdentity();
  const commit = putObject(
    'commit',
    buildCommit({ tree, parents: tip === null ? [] : [tip], author: identity, committer: identity, message }),
  );
  repo.refs.set(`refs/heads/${branch}`, commit);
  return commit;
}

/** The blob oid at `path` in a tree, or null. */
export function blobAtPath(treeOid: string, path: string): string | null {
  const flat = flattenTree(treeOid);
  return flat.get(path) ?? null;
}

// ---------------------------------------------------------------------------
// Three-way tree merge (squash/merge) and pull-request diffs
// ---------------------------------------------------------------------------

export interface MergeOutcome {
  tree: string;
  conflicts: string[];
}

/** Per-path three-way merge of flattened trees: the suite's conflict case is one file changed two ways. */
export function mergeTrees(ancestorTree: string, baseTree: string, headTree: string): MergeOutcome {
  const ancestor = flattenTree(ancestorTree);
  const base = flattenTree(baseTree);
  const head = flattenTree(headTree);
  const merged = new Map<string, string>();
  const conflicts: string[] = [];
  const paths = new Set([...ancestor.keys(), ...base.keys(), ...head.keys()]);
  for (const path of paths) {
    const a = ancestor.get(path);
    const b = base.get(path);
    const h = head.get(path);
    if (h === a) {
      if (b !== undefined) merged.set(path, b);
    } else if (b === a) {
      if (h !== undefined) merged.set(path, h);
    } else if (h === b) {
      if (h !== undefined) merged.set(path, h);
    } else {
      conflicts.push(path);
    }
  }
  return { tree: treeFromFlat(merged), conflicts };
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

/** Line-level diff counts via LCS (files in this forge are small; a cap keeps big ones cheap). */
function diffCounts(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  if (oldData === null) return { additions: countLines(newData ?? Buffer.alloc(0)), deletions: 0 };
  if (newData === null) return { additions: 0, deletions: countLines(oldData) };
  const oldLines = oldData.toString('utf8').split('\n');
  const newLines = newData.toString('utf8').split('\n');
  if (oldLines.length > 4000 || newLines.length > 4000) {
    return { additions: newLines.length, deletions: oldLines.length };
  }
  // LCS length via two-row DP.
  let prev = new Array<number>(newLines.length + 1).fill(0);
  let curr = new Array<number>(newLines.length + 1).fill(0);
  for (let i = 1; i <= oldLines.length; i += 1) {
    for (let j = 1; j <= newLines.length; j += 1) {
      curr[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  const lcs = prev[newLines.length];
  return { additions: newLines.length - lcs, deletions: oldLines.length - lcs };
}

/** The changed files between two trees (a pull request's files view). */
export function diffTrees(fromTree: string, toTree: string): FileChange[] {
  const from = flattenTree(fromTree);
  const to = flattenTree(toTree);
  const changes: FileChange[] = [];
  const paths = new Set([...from.keys(), ...to.keys()]);
  for (const path of [...paths].sort()) {
    const before = from.get(path);
    const after = to.get(path);
    if (before === after) continue;
    const oldData = before === undefined ? null : (objects.get(before)?.data ?? null);
    const newData = after === undefined ? null : (objects.get(after)?.data ?? null);
    const { additions, deletions } = diffCounts(oldData, newData);
    changes.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return changes;
}

/** Whether merging `pull` into its base would conflict, and the merge-base the merge would use. */
export function pullMergePreview(repo: Repo, pull: Pull): { base: string | null; conflicts: string[] } {
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return { base: null, conflicts: ['missing ref'] };
  const ancestor = mergeBase(baseTip, headTip);
  if (ancestor === null) return { base: null, conflicts: ['no common ancestor'] };
  const ancestorTree = commitTree(ancestor);
  const baseTree = commitTree(baseTip);
  const headTree = commitTree(headTip);
  if (ancestorTree === null || baseTree === null || headTree === null) return { base: ancestor, conflicts: ['missing tree'] };
  return { base: ancestor, conflicts: mergeTrees(ancestorTree, baseTree, headTree).conflicts };
}

/**
 * Merge a pull request (squash = one parent, merge = two). On success the base branch advances,
 * the pull closes as merged, and the merge commit oid is returned; on conflict nothing moves.
 */
export function mergePull(repo: Repo, pull: Pull, method: 'squash' | 'merge' | 'rebase'): { sha: string } | { conflict: string[] } {
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return { conflict: ['missing ref'] };
  const ancestor = mergeBase(baseTip, headTip);
  if (ancestor === null) return { conflict: ['no common ancestor'] };
  const outcome = mergeTrees(commitTree(ancestor)!, commitTree(baseTip)!, commitTree(headTip)!);
  if (outcome.conflicts.length > 0) return { conflict: outcome.conflicts };
  const identity = serverIdentity();
  const message =
    method === 'merge'
      ? `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`
      : `${pull.title} (#${pull.number})${pull.body === '' ? '\n' : `\n\n${pull.body}\n`}`;
  const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
  const commit = putObject('commit', buildCommit({ tree: outcome.tree, parents, author: identity, committer: identity, message }));
  repo.refs.set(`refs/heads/${pull.baseRef}`, commit);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = commit;
  return { sha: commit };
}
