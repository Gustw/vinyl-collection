/**
 * Proves the waits survive a throttled background tab.
 *
 * Browsers clamp timers in a hidden page — Chrome to about once a minute for
 * chained timers after ~5 minutes hidden. Two separate faults follow from that,
 * and both are checked here on a virtual clock:
 *
 *  1. A wait built by counting fixed slices *multiplies* the clamp, so a 60s
 *     backoff becomes hours. Deadline-driven waiting fixes this even when the
 *     main thread is all we have.
 *  2. A wait shorter than the clamp still costs a whole clamp period, so the
 *     half-second pacing between tracks becomes a minute each. Only moving the
 *     timer into a Web Worker fixes that, since worker timers keep ticking.
 *
 * Run with: npm run check:timers
 */

// --- a virtual clock with a Chrome-like throttle -------------------------

let now = 0;
type Task = { at: number; fn: () => void; id: number };
let queue: Task[] = [];
let seq = 1;

/** Minimum spacing the "browser" allows between main-thread timer callbacks. */
let clampMs = 0;
let lastFireAt = -Infinity;
/** Whether the simulated Worker is also throttled (i.e. no real worker help). */
let workerThrottled = false;

function schedule(fn: () => void, ms: number, throttled: boolean): number {
  const earliest = throttled ? Math.max(now + ms, lastFireAt + clampMs) : now + ms;
  const id = seq++;
  queue.push({ at: earliest, fn, id });
  return id;
}

(globalThis as any).setTimeout = (fn: () => void, ms = 0) => schedule(fn, ms, true);
(globalThis as any).clearTimeout = (id: any) => {
  queue = queue.filter((t) => t.id !== id);
};
(globalThis as any).Date.now = () => now;

// A Worker stub whose timers are (optionally) exempt from the clamp — which is
// the property the real implementation relies on.
(globalThis as any).Blob = class {
  constructor(public parts: string[]) {}
};
(globalThis as any).URL = {
  createObjectURL: () => 'blob:stub',
  revokeObjectURL: () => {},
};
(globalThis as any).Worker = class {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage(d: { id: number; ms: number }) {
    schedule(() => this.onmessage?.({ data: d.id }), d.ms, workerThrottled);
  }
};

/** Runs the virtual clock until everything settles. */
async function drain(budgetMs = 1000 * 60 * 60 * 24 * 7): Promise<void> {
  const startedAt = now;
  while (queue.length) {
    queue.sort((a, b) => a.at - b.at || a.id - b.id);
    const next = queue.shift()!;
    now = Math.max(now, next.at);
    lastFireAt = now;
    if (now - startedAt > budgetMs) throw new Error('virtual clock budget exceeded');
    next.fn();
    await Promise.resolve();
    await Promise.resolve();
  }
}

// Imported after the clock and Worker stubs are in place.
const { waitFor } = await import('../src/app/timers');

// --- the old implementation, for comparison ------------------------------

const rawSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** How the waits used to be written: count down in fixed slices. */
async function sliceCountingWait(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 250) await rawSleep(Math.min(250, left));
}

// --- assertions ----------------------------------------------------------

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (ok) console.log(`  ok   ${label}${detail ? ' — ' + detail : ''}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`);
  }
}

function fmt(ms: number): string {
  if (ms >= 3600000) return `${(ms / 3600000).toFixed(1)}h`;
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Runs `body` on the virtual clock and returns the elapsed virtual time. */
async function elapsed(body: () => Promise<unknown>): Promise<number> {
  lastFireAt = -Infinity;
  const start = now;
  let done = false;
  void body().then(() => (done = true));
  await drain();
  if (!done) throw new Error('wait never resolved');
  return now - start;
}

const TRACKS = 1752; // the size of the real collection

async function main() {
  console.log('\nForeground tab (no throttling)');
  clampMs = 0;
  workerThrottled = false;
  {
    const t = await elapsed(() => waitFor(500));
    check('500ms pacing wait is accurate', t >= 500 && t < 800, fmt(t));
    const b = await elapsed(() => waitFor(60000));
    check('60s backoff is accurate', b >= 60000 && b < 61000, fmt(b));
  }

  console.log('\nBackground tab, Chrome-style 1/minute clamp');
  clampMs = 60000;

  console.log('\n  Fault 1 - a long backoff must not be multiplied by its slices');
  {
    // Worker throttled too, so this isolates the deadline fix on its own.
    workerThrottled = true;
    const oldWait = await elapsed(() => sliceCountingWait(60000));
    const newWait = await elapsed(() => waitFor(60000));
    console.log(`       old slice-counting: ${fmt(oldWait)}`);
    console.log(`       deadline-based    : ${fmt(newWait)}`);
    check('old implementation was pathological', oldWait > 60 * 60 * 1000, fmt(oldWait));
    check('now bounded by one throttled tick', newWait <= 2 * clampMs, fmt(newWait));
  }

  console.log('\n  Fault 2 - short pacing waits must not each cost a full clamp');
  {
    workerThrottled = true;
    const withoutWorker = await elapsed(() => waitFor(500));
    workerThrottled = false;
    const withWorker = await elapsed(() => waitFor(500));
    console.log(
      `       main thread only : ${fmt(withoutWorker)}  ->  ${fmt(withoutWorker * TRACKS)} for ${TRACKS} tracks`
    );
    console.log(
      `       via worker timer : ${fmt(withWorker)}  ->  ${fmt(withWorker * TRACKS)} for ${TRACKS} tracks`
    );
    check('the worker restores accurate pacing', withWorker >= 500 && withWorker < 800, fmt(withWorker));
    check(
      'a full pass stays feasible in a hidden tab',
      withWorker * TRACKS < 60 * 60 * 1000,
      fmt(withWorker * TRACKS)
    );
  }

  console.log('\n  A rate-limit backoff via the worker is honest too');
  {
    workerThrottled = false;
    const b = await elapsed(() => waitFor(60000));
    check('60s stays 60s', b >= 60000 && b < 61000, fmt(b));
  }

  console.log('\nCancellation is still prompt');
  {
    clampMs = 0;
    workerThrottled = false;
    lastFireAt = -Infinity;
    let cancelled = false;
    const start = now;
    let result: { waited: number; cancelled: boolean } | null = null;
    void waitFor(60000, () => cancelled).then((r) => (result = r));
    queue.sort((a, b) => a.at - b.at);
    const first = queue.shift()!;
    now = first.at;
    first.fn();
    await Promise.resolve();
    await Promise.resolve();
    cancelled = true;
    await drain();
    check('reported as cancelled', !!result && (result as any).cancelled === true);
    check('stopped early', now - start < 60000, fmt(now - start));
  }

  console.log('\nA late timer ends the wait instead of extending it');
  {
    clampMs = 0;
    workerThrottled = false;
    const t = await elapsed(async () => {
      const p = waitFor(1000);
      for (const task of queue) task.at = now + 600000; // one huge overshoot
      return p;
    });
    check('one overshoot, then done', t <= 700000, fmt(t));
  }

  console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nAll checks passed\n');
  process.exit(failures ? 1 : 0);
}

void main();

