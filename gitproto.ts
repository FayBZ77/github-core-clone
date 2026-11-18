// gitproto.ts — git smart-HTTP: protocol v2 (ls-refs, fetch) and v0 (advertisements, push).
//
// The wire shapes mirror what the suite's own git client parses: pkt-line framing everywhere,
// sideband-64k around pack data and the push report-status, and a real SHA-1 pack with a
// verifiable trailer. Fetches send complete (never thin, never delta-compressed) packs of
// exactly the closure the client lacks; pushes validate fast-forwards per ref and report
// ok/ng per command, applying the good ones.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  getObject,
  hashObject,
  objects,
  parseCommit,
  peelToCommit,
  reachableFrom,
  refCommit,
  treeClosureOf,
  type GitObjectType,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

export type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' };

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Parse as many whole pkt-lines as `buffer` holds; returns the packets and the bytes consumed. */
export function parsePackets(buffer: Buffer, offset = 0): { packets: Packet[]; consumed: number } {
  const packets: Packet[] = [];
  let at = offset;
  while (at + 4 <= buffer.length) {
    const hex = buffer.toString('ascii', at, at + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const length = parseInt(hex, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      at += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (length === 2 || length === 3) break; // response-end / invalid: stop
    if (at + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(at + 4, at + length) });
    at += length;
  }
  return { packets, consumed: at - offset };
}

// ---------------------------------------------------------------------------
// Packs
// ---------------------------------------------------------------------------

const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function writePack(entries: readonly { type: GitObjectType; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  parts.push(header);
  for (const entry of entries) {
    let size = entry.data.length;
    const typeCode = TYPE_CODES[entry.type];
    const bytes: number[] = [];
    let first = (typeCode << 4) | (size & 0x0f);
    size >>= 4;
    if (size > 0) first |= 0x80;
    bytes.push(first);
    while (size > 0) {
      let byte = size & 0x7f;
      size >>= 7;
      if (size > 0) byte |= 0x80;
      bytes.push(byte);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(entry.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/**
 * Inflate one zlib stream starting at `start`. inflateSync ignores trailing bytes, so the
 * stream's exact end is the smallest prefix that still inflates to the same output: any
 * shorter prefix truncates the stream and throws. Binary-search for that prefix.
 */
function inflateAt(buffer: Buffer, start: number): { data: Buffer; consumed: number } {
  const rest = buffer.subarray(start);
  const full = inflateSync(rest); // throws when the stream is corrupt: the caller reports unpack failure
  // The compressed form is never much larger than the plain data; bound the search when possible.
  let hi = Math.min(rest.length, full.length + Math.ceil(full.length / 4) + 64);
  let bounded = true;
  try {
    if (!inflateSync(rest.subarray(0, hi)).equals(full)) bounded = false;
  } catch {
    bounded = false;
  }
  if (!bounded) hi = rest.length;
  let lo = 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    let ok = false;
    try {
      ok = inflateSync(rest.subarray(0, mid)).equals(full);
    } catch {
      ok = false;
    }
    if (ok) hi = mid;
    else lo = mid + 1;
  }
  return { data: full, consumed: lo };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at];
      at += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint(); // base size
  const targetSize = readVarint();
  const out: Buffer[] = [];
  while (at < delta.length) {
    const op = delta[at];
    at += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          offset |= delta[at] << (8 * bit);
          at += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          size |= delta[at] << (8 * bit);
          at += 1;
        }
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
    } else if (op > 0) {
      out.push(delta.subarray(at, at + op));
      at += op;
    } else {
      throw new Error('bad delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize) throw new Error('delta size mismatch');
  return result;
}

export interface ParsedPack {
  objects: { type: GitObjectType; data: Buffer; oid: string }[];
}

/** Parse a pack (full objects plus ofs/ref deltas) into resolved objects, verifying the trailer. */
export function readPack(pack: Buffer): ParsedPack {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a pack');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(digest)) throw new Error('pack checksum mismatch');
  let at = 12;
  const raw: { type: GitObjectType | 'ofs-delta' | 'ref-delta'; data: Buffer; baseOid?: string; baseOffset?: number; start: number }[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = at;
    let byte = pack[at];
    at += 1;
    const code = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[at];
      at += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (code === 6) {
      // ofs-delta: negative offset varint
      let back = pack[at];
      at += 1;
      let offset = back & 0x7f;
      while (back & 0x80) {
        back = pack[at];
        at += 1;
        offset = ((offset + 1) << 7) | (back & 0x7f);
      }
      const inflated = inflateAt(pack, at);
      at += inflated.consumed;
      raw.push({ type: 'ofs-delta', data: inflated.data, baseOffset: start - offset, start });
    } else if (code === 7) {
      const baseOid = pack.toString('hex', at, at + 20);
      at += 20;
      const inflated = inflateAt(pack, at);
      at += inflated.consumed;
      raw.push({ type: 'ref-delta', data: inflated.data, baseOid, start });
    } else {
      const type = CODE_TYPES[code];
      if (type === undefined) throw new Error(`unknown pack object type ${code}`);
      const inflated = inflateAt(pack, at);
      at += inflated.consumed;
      if (inflated.data.length !== size) throw new Error('pack object size mismatch');
      raw.push({ type, data: inflated.data, start });
    }
  }
  // Resolve in order; delta bases precede their deltas in a well-formed pack.
  const byOffset = new Map<number, { type: GitObjectType; data: Buffer; oid: string }>();
  const resolved: { type: GitObjectType; data: Buffer; oid: string }[] = [];
  for (const entry of raw) {
    if (entry.type === 'ofs-delta') {
      const base = byOffset.get(entry.baseOffset!);
      if (base === undefined) throw new Error('ofs-delta base missing');
      const data = applyDelta(base.data, entry.data);
      const done = { type: base.type, data, oid: hashObject(base.type, data) };
      byOffset.set(entry.start, done);
      resolved.push(done);
    } else if (entry.type === 'ref-delta') {
      const baseObject = getObject(entry.baseOid!) ?? resolved.find((candidate) => candidate.oid === entry.baseOid);
      if (baseObject === undefined) throw new Error('ref-delta base missing');
      const data = applyDelta(baseObject.data, entry.data);
      const done = { type: baseObject.type, data, oid: hashObject(baseObject.type, data) };
      byOffset.set(entry.start, done);
      resolved.push(done);
    } else {
      const done = { type: entry.type, data: entry.data, oid: hashObject(entry.type, entry.data) };
      byOffset.set(entry.start, done);
      resolved.push(done);
    }
  }
  return { objects: resolved };
}

// ---------------------------------------------------------------------------
// Advertisements and ls-refs
// ---------------------------------------------------------------------------

const AGENT = 'github-core-clone/1.0';
const UPLOAD_CAPS_V0 = `multi_ack_detailed no-done side-band-64k thin-pack ofs-delta deepen-since deepen-not agent=${AGENT}`;
export const RECEIVE_CAPS_V0 = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

export function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** The v0 ref advertisement body (after the service preamble): refs with capabilities on line one. */
export function v0Advertisement(repo: Repo, capabilities: string): Buffer {
  const parts: Buffer[] = [];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(headTarget(repo));
  const lines: string[] = [];
  if (headOid !== undefined) lines.push(`${headOid} HEAD`);
  for (const [name, oid] of refs) lines.push(`${oid} ${name}`);
  if (lines.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${capabilities}`));
  } else {
    lines.forEach((line, index) => {
      parts.push(pktLine(index === 0 ? `${line}\0${capabilities}` : `${line}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v2 capability advertisement (after the service preamble and its flush). */
export function v2Advertisement(): Buffer {
  const lines = [
    'version 2',
    `agent=${AGENT}`,
    'object-format=sha1',
    'fetch=shallow wait-for-done',
    'ls-refs=unborn',
  ];
  return Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
}

export interface LsRefsRequest {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

export function lsRefsReply(repo: Repo, request: LsRefsRequest): Buffer {
  const lines: string[] = [];
  const names: { name: string; oid: string }[] = [];
  const head = headTarget(repo);
  const headOid = repo.refs.get(head);
  if (headOid !== undefined) {
    names.push({ name: 'HEAD', oid: headOid });
  } else if (request.unborn) {
    names.push({ name: 'HEAD', oid: ZERO_OID });
  }
  for (const [name, oid] of sortedRefs(repo)) names.push({ name, oid });
  for (const { name, oid } of names) {
    if (request.prefixes.length > 0 && !request.prefixes.some((prefix) => name.startsWith(prefix))) continue;
    let line = `${oid} ${name}`;
    if (name === 'HEAD') line += ` symref-target:${head}`;
    if (request.peel && oid !== ZERO_OID) {
      const object = getObject(oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToCommit(oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    lines.push(line);
  }
  return Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
}

/** The v0 upload-pack advertisement also lists peeled tags, as `ref^{}` lines. */
export function v0UploadAdvertisement(repo: Repo): Buffer {
  const parts: Buffer[] = [];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(headTarget(repo));
  const lines: string[] = [];
  if (headOid !== undefined) lines.push(`${headOid} HEAD`);
  for (const [name, oid] of refs) {
    lines.push(`${oid} ${name}`);
    const object = getObject(oid);
    if (object !== undefined && object.type === 'tag') {
      const peeled = peelToCommit(oid);
      if (peeled !== null) lines.push(`${peeled} ${name}^{}`);
    }
  }
  if (lines.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${UPLOAD_CAPS_V0}`));
  } else {
    lines.forEach((line, index) => {
      parts.push(pktLine(index === 0 ? `${line}\0${UPLOAD_CAPS_V0}` : `${line}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

interface FetchPlan {
  send: Set<string>;
  shallowLines: string[];
}

/**
 * Compute the object set for a fetch: the closure of the wants the client lacks, honouring
 * haves (full history) and the client's shallow boundary, cut at `depth` when one is given.
 */
export function planFetch(repo: Repo, request: FetchRequest): FetchPlan {
  const haveSet = new Set(request.haves);
  const shallowSet = new Set(request.shallow);
  // Objects the client already holds: full closure of non-shallow haves; tree closure of shallow ones.
  const possessed = new Set<string>();
  for (const have of request.haves) {
    if (shallowSet.has(have)) treeClosureOf(have, possessed);
    else reachableFrom([have], possessed);
  }
  const fullyPossessed = new Set<string>();
  for (const have of request.haves) {
    if (!shallowSet.has(have)) reachableFrom([have], fullyPossessed);
  }

  const depth = request.depth;
  const includedCommits = new Map<string, number>(); // commit -> distance from a want
  const tagObjects: string[] = [];
  const queue: { oid: string; dist: number }[] = [];
  for (const want of request.wants) {
    const object = getObject(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      tagObjects.push(want);
      const commit = peelToCommit(want);
      if (commit !== null) queue.push({ oid: commit, dist: 1 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, dist: 1 });
    } else {
      tagObjects.push(want); // a tree/blob want: send the object itself
    }
  }
  const wantCommits = new Set(queue.map((entry) => entry.oid));
  while (queue.length > 0) {
    const { oid, dist } = queue.shift()!;
    const known = includedCommits.get(oid);
    if (known !== undefined && known <= dist) continue;
    const object = getObject(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const isHave = haveSet.has(oid);
    const isShallowHave = shallowSet.has(oid);
    if (fullyPossessed.has(oid) && !wantCommits.has(oid)) continue;
    // A shallow boundary the client already holds is never expanded through, except when it is
    // the want itself (a deepen request): its ancestors stay cut.
    if (isShallowHave && !wantCommits.has(oid)) continue;
    if (depth !== null && dist > depth) continue;
    // A possessed commit is not re-sent, but a wanted shallow commit still expands (deepen).
    if (!isHave || isShallowHave) includedCommits.set(oid, dist);
    const expand = depth === null || dist < depth;
    if (!expand) continue;
    if (fullyPossessed.has(oid)) continue; // the client holds its whole ancestry
    if (isHave && !isShallowHave && !wantCommits.has(oid)) continue;
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, dist: dist + 1 });
  }

  const send = new Set<string>();
  for (const oid of tagObjects) if (!possessed.has(oid)) send.add(oid);
  for (const commit of includedCommits.keys()) treeClosureOf(commit, send);
  for (const oid of possessed) send.delete(oid);

  const shallowLines: string[] = [];
  for (const [commit] of includedCommits) {
    const object = getObject(commit);
    if (object === undefined) continue;
    const parents = parseCommit(object.data).parents;
    const cut = parents.some((parent) => !includedCommits.has(parent) && !fullyPossessed.has(parent));
    if (cut) shallowLines.push(`shallow ${commit}`);
  }
  for (const shallow of shallowSet) {
    const object = getObject(shallow);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length > 0 && parents.every((parent) => includedCommits.has(parent) || fullyPossessed.has(parent))) {
      shallowLines.push(`unshallow ${shallow}`);
    }
  }
  return { send, shallowLines };
}

/** Frame a pack in sideband band 1, chunked well under the pkt-line ceiling. */
export function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let at = 0; at < pack.length; at += CHUNK) {
    const chunk = pack.subarray(at, Math.min(pack.length, at + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(pktLine(payload));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}

export function fetchReply(repo: Repo, request: FetchRequest): Buffer {
  const parts: Buffer[] = [];
  // acknowledgments
  const ackLines: string[] = [];
  const common = request.haves.find((have) => getObject(have) !== undefined);
  if (request.haves.length === 0) ackLines.push('NAK');
  else {
    if (common !== undefined) ackLines.push(`ACK ${common}`);
    ackLines.push('ready');
  }
  parts.push(pktLine('acknowledgments\n'), ...ackLines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH);
  const plan = planFetch(repo, request);
  if (request.depth !== null || request.shallow.length > 0 || plan.shallowLines.length > 0) {
    parts.push(pktLine('shallow-info\n'), ...plan.shallowLines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH);
  }
  const entries = [...plan.send]
    .map((oid) => getObject(oid))
    .filter((object): object is NonNullable<typeof object> => object !== undefined)
    .map((object) => ({ type: object.type, data: object.data }));
  const pack = writePack(entries);
  parts.push(pktLine('packfile\n'), sidebandPack(pack), PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Receive-pack (push)
// ---------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushOutcome {
  unpackOk: boolean;
  unpackDetail: string;
  results: { ref: string; ok: boolean; reason: string }[];
}

/** Store a push's pack, then validate and apply its ref updates one by one. */
export function applyPush(repo: Repo, commands: readonly PushCommand[], pack: Buffer | null): PushOutcome {
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack !== null && pack.length > 0) {
    try {
      const parsed = readPack(pack);
      for (const object of parsed.objects) {
        if (!objects.has(object.oid)) objects.set(object.oid, { type: object.type, data: object.data });
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }
  const results: PushOutcome['results'] = [];
  for (const command of commands) {
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: `unpack failed: ${unpackDetail}` });
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      results.push({
        ref: command.ref,
        ok: false,
        reason: command.oldOid === ZERO_OID ? 'reference already exists' : 'stale info',
      });
      continue;
    }
    if (command.newOid === ZERO_OID) {
      if (current === ZERO_OID) {
        results.push({ ref: command.ref, ok: false, reason: 'reference does not exist' });
        continue;
      }
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (getObject(command.newOid) === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'missing object' });
      continue;
    }
    if (command.oldOid !== ZERO_OID) {
      const oldCommit = refCommit(command.oldOid);
      const newCommit = refCommit(command.newOid);
      if (oldCommit !== null && newCommit !== null && oldCommit !== newCommit) {
        // Ancestry over the union of the stored history (the pack is already stored).
        const ancestors = new Set<string>();
        const stack = [newCommit];
        let found = false;
        while (stack.length > 0) {
          const oid = stack.pop()!;
          if (oid === oldCommit) {
            found = true;
            break;
          }
          if (ancestors.has(oid)) continue;
          ancestors.add(oid);
          const object = getObject(oid);
          if (object !== undefined && object.type === 'commit') stack.push(...parseCommit(object.data).parents);
        }
        if (!found) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
      }
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  return { unpackOk, unpackDetail, results };
}

/** The report-status reply: sideband band-1 pkt-lines, then a plain flush. */
export function pushReportReply(outcome: PushOutcome): Buffer {
  const parts: Buffer[] = [];
  const wrap = (payload: Buffer): Buffer => pktLine(Buffer.concat([Buffer.from([1]), payload]));
  parts.push(wrap(pktLine(outcome.unpackOk ? 'unpack ok\n' : `unpack ${outcome.unpackDetail}\n`)));
  for (const result of outcome.results) {
    parts.push(wrap(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`)));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}
