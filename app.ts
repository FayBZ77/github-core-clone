// app.ts — the HTTP server: routing, auth, body handling, and the git smart-HTTP endpoints.
// The surfaces live in rest.ts (REST v3), graphql.ts (GraphQL v4), mcp.ts (MCP) and
// gitproto.ts (the git wire protocol); this file only moves bytes between them and the socket.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleRest, HttpError, type Reply, type RestContext } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  PKT_FLUSH,
  RECEIVE_CAPS_V0,
  applyPush,
  fetchReply,
  lsRefsReply,
  parsePackets,
  pktLine,
  pushReportReply,
  v0Advertisement,
  v0UploadAdvertisement,
  v2Advertisement,
  type FetchRequest,
  type LsRefsRequest,
  type PushCommand,
} from './gitproto.ts';
import { findRepo, type Repo } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16).padStart(8, '0')}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (status === 204 || body === null || body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function isAuthed(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  return typeof header === 'string' && /^(Bearer|token)\s+\S+/i.test(header);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ---------------------------------------------------------------------------
// Git smart-HTTP
// ---------------------------------------------------------------------------

function servicePreamble(service: string): Buffer {
  return Buffer.concat([pktLine(`# service=${service}\n`), PKT_FLUSH]);
}

function handleInfoRefs(res: ServerResponse, repo: Repo | undefined, service: string, url: URL, req: IncomingMessage): void {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendJson(res, 400, { message: 'Invalid service' });
    return;
  }
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-receive-pack') {
    sendBuffer(res, 200, Buffer.concat([servicePreamble(service), v0Advertisement(repo, RECEIVE_CAPS_V0)]), contentType);
    return;
  }
  const protocol = req.headers['git-protocol'];
  if (typeof protocol === 'string' && protocol.includes('version=2')) {
    sendBuffer(res, 200, Buffer.concat([servicePreamble(service), v2Advertisement()]), contentType);
    return;
  }
  sendBuffer(res, 200, Buffer.concat([servicePreamble(service), v0UploadAdvertisement(repo)]), contentType);
}

/** Split a v2 command request into its argument lines (after the delim) — or all lines for v0-style bodies. */
function commandArguments(body: Buffer): { head: string[]; args: string[]; rest: Buffer } {
  const { packets, consumed } = parsePackets(body);
  const head: string[] = [];
  const args: string[] = [];
  let inArgs = false;
  let used = 0;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      used += 4;
      continue;
    }
    if (packet.kind === 'flush') {
      used += 4;
      break;
    }
    used += 4 + packet.payload.length;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (inArgs) args.push(line);
    else head.push(line);
  }
  void consumed;
  return { head, args, rest: body.subarray(used) };
}

function handleUploadPack(res: ServerResponse, repo: Repo | undefined, body: Buffer): void {
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const { head, args } = commandArguments(body);
  const command = head.find((line) => line.startsWith('command='));
  if (command === 'command=ls-refs') {
    const request: LsRefsRequest = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const arg of args) {
      if (arg === 'peel') request.peel = true;
      else if (arg === 'symrefs') request.symrefs = true;
      else if (arg === 'unborn') request.unborn = true;
      else if (arg.startsWith('ref-prefix ')) request.prefixes.push(arg.slice('ref-prefix '.length));
    }
    sendBuffer(res, 200, lsRefsReply(repo, request), 'application/x-git-upload-pack-result');
    return;
  }
  if (command === 'command=fetch') {
    const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
    for (const arg of args) {
      if (arg.startsWith('want ')) request.wants.push(arg.slice(5).trim());
      else if (arg.startsWith('have ')) request.haves.push(arg.slice(5).trim());
      else if (arg.startsWith('shallow ')) request.shallow.push(arg.slice(8).trim());
      else if (arg.startsWith('deepen ')) request.depth = Number(arg.slice(7).trim()) || request.depth;
    }
    sendBuffer(res, 200, fetchReply(repo, request), 'application/x-git-upload-pack-result');
    return;
  }
  sendJson(res, 400, { message: 'Unsupported command' });
}

function handleReceivePack(res: ServerResponse, repo: Repo | undefined, body: Buffer): void {
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const { packets, consumed } = parsePackets(body);
  const commands: PushCommand[] = [];
  let used = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      used += 4;
      break;
    }
    if (packet.kind !== 'data') {
      used += 4;
      continue;
    }
    used += 4 + packet.payload.length;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
    }
  }
  void consumed;
  const rest = body.subarray(used);
  const pack = rest.length >= 4 && rest.toString('ascii', 0, 4) === 'PACK' ? rest : null;
  const outcome = applyPush(repo, commands, pack);
  sendBuffer(res, 200, pushReportReply(outcome), 'application/x-git-receive-pack-result');
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

export function createApp(): Server {
  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      try {
        if (error instanceof HttpError) sendJson(res, error.status, { message: error.message });
        else sendJson(res, 500, { message: 'Internal Server Error' });
      } catch {
        // The socket is already gone; nothing more to do.
      }
    });
  });
  return server;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, 400, { message: 'Bad Request' });
    return;
  }
  const path = url.pathname;

  if (path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path === '/mcp') {
    const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    const reply = handleMcp({ method, body, authed: isAuthed(req) });
    sendJson(res, reply.status, reply.body, reply.headers);
    return;
  }

  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!isAuthed(req)) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return;
    }
    const body = await readBody(req);
    const reply = handleGraphql(body);
    sendJson(res, reply.status, reply.body, reply.headers);
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const requestId = nextRequestId();
    if (!isAuthed(req)) {
      sendJson(res, 401, { message: 'Requires authentication' }, { 'x-github-request-id': requestId });
      return;
    }
    let body: RestContext['body'] = null;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          const parsed: unknown = JSON.parse(raw.toString('utf8'));
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            sendJson(res, 400, { message: 'Invalid JSON body' }, { 'x-github-request-id': requestId });
            return;
          }
          body = parsed as Record<string, unknown>;
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON' }, { 'x-github-request-id': requestId });
          return;
        }
      }
    }
    const segments = path
      .slice('/api/v3'.length)
      .split('/')
      .filter((segment) => segment !== '')
      .map(decodeSegment);
    const host = req.headers.host ?? 'localhost';
    const reply: Reply = handleRest({
      method,
      segments,
      query: url.searchParams,
      body,
      origin: `http://${host}`,
      path,
    });
    sendJson(res, reply.status, reply.body, { 'x-github-request-id': requestId, ...(reply.headers ?? {}) });
    return;
  }

  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch !== null) {
    const owner = decodeSegment(gitMatch[1]);
    const name = decodeSegment(gitMatch[2]);
    const repo = findRepo(owner, name);
    const endpoint = gitMatch[3];
    if (endpoint === 'info/refs') {
      handleInfoRefs(res, repo, url.searchParams.get('service') ?? '', url, req);
      return;
    }
    const body = await readBody(req);
    if (endpoint === 'git-upload-pack') {
      handleUploadPack(res, repo, body);
      return;
    }
    handleReceivePack(res, repo, body);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
