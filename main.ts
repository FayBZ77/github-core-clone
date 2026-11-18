// main.ts — the forge entry's process lifecycle.
//
// This process and the trial harness (the "env") keep a simple arrangement:
//
//   * The env names itself through MAKEFUN_ENV_URL. With no URL there is no
//     trial to serve, so the process exits 1 at once instead of idling.
//   * The forge binds an ephemeral port — listen(0), never 8080, which is the
//     env's own — and POSTs that port to <env>/register so the env can dial
//     back in. Registration is retried while the env is still coming up: a
//     409 only means another process registered first and is not an error
//     here, but a 400 or 405 says this process broke the contract, which is
//     fatal.
//   * After that the process polls <env>/done. The env answers immediately
//     with {"done": false} while its suite runs, so the protocol is a poll,
//     not one long-held request. Only a {"done": true} answer ends the wait:
//     the server closes and the process exits 0. Nothing else — no error, no
//     slow poll — ends this process early.
//
// Everything the suite actually scores lives behind createApp() in app.ts;
// this file only owns startup, registration, the wait, and shutdown.

import { createApp } from './app.ts';

/** One call to the env may take at most this long before it counts as failed. */
const CALL_TIMEOUT_MS = 30_000;
/** The pause after a first failure; it doubles per failure up to the ceiling. */
const PAUSE_FIRST_MS = 250;
const PAUSE_LONGEST_MS = 2_000;

/** A refusal the env will never take back (a contract breach): retrying is pointless. */
class ContractError extends Error {}

function pause(failures: number): Promise<void> {
  const ms = Math.min(PAUSE_LONGEST_MS, PAUSE_FIRST_MS * 2 ** Math.min(failures, 8));
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drive `step` until it reports completion. A step finishes by returning
 * true; returning false or throwing (a network error, a timeout, a status
 * that may pass once the env is up) means "not yet" and is retried after a
 * growing pause. A ContractError is rethrown: the env has given a final
 * answer and no amount of waiting changes it.
 */
async function drive(step: () => Promise<boolean>): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    let finished = false;
    try {
      finished = await step();
    } catch (err) {
      if (err instanceof ContractError) throw err;
    }
    if (finished) return;
    await pause(failures);
  }
}

/**
 * Read and discard a response's body. A response whose body is never read
 * pins its keep-alive socket until the runtime gives up on it; on a retry
 * path that would slowly strand sockets against an env that is still
 * booting, so every answer we do not otherwise consume gets drained.
 */
async function drain(res: Response): Promise<void> {
  try {
    await res.text();
  } catch {
    // A body that cannot be read is abandoned either way; the retry decides what happens next.
  }
}

/** The env's origin with any trailing slashes removed; exits 1 when unset. */
function envOrigin(): string {
  const origin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (origin === '') {
    process.stderr.write('[forge] MAKEFUN_ENV_URL is not set: no env to register with\n');
    process.exit(1);
  }
  return origin;
}

/** POST the bound port to the env until it is recorded (200) or already was (409). */
async function registerWithEnv(origin: string, port: number): Promise<void> {
  await drive(async () => {
    const res = await fetch(`${origin}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (res.status === 200 || res.status === 409) {
      await drain(res);
      return true;
    }
    if (res.status === 400 || res.status === 405) {
      throw new ContractError(`register answered HTTP ${res.status}: ${await res.text()}`);
    }
    await drain(res);
    return false;
  });
}

/** Poll the env until it answers {"done": true}; never return before that. */
async function awaitEnvFinish(origin: string): Promise<void> {
  await drive(async () => {
    const res = await fetch(`${origin}/done`, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    if (!res.ok) {
      await drain(res);
      return false;
    }
    const body: unknown = await res.json();
    return typeof body === 'object' && body !== null && (body as { done?: unknown }).done === true;
  });
}

/** Start the forge on an ephemeral port and resolve with the port it bound. */
function bindEphemeral(): Promise<{ server: ReturnType<typeof createApp>; port: number }> {
  const server = createApp();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the server did not bind an ephemeral TCP port'));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

/**
 * Close the server and wait until it has actually stopped. close() alone
 * waits for connections the suite left idle-open to time out on their own;
 * dropping the idle ones explicitly lets shutdown finish at once, while a
 * connection still mid-request is left to complete.
 */
async function shutdown(server: ReturnType<typeof createApp>): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });
}

/** The whole life of the process: bind, register, wait for done, close. */
async function run(): Promise<void> {
  const origin = envOrigin();
  const { server, port } = await bindEphemeral();
  process.stdout.write(`[forge] listening on port ${port}\n`);

  await registerWithEnv(origin, port);
  process.stdout.write('[forge] registered; waiting for the env to say done\n');

  await awaitEnvFinish(origin);
  await shutdown(server);
  process.stdout.write('[forge] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
