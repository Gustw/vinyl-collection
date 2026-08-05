/**
 * Timers that survive the tab being in the background.
 *
 * Browsers deliberately slow hidden tabs down. Chrome clamps timers in a hidden
 * page to roughly once a second, and after about five minutes applies
 * "intensive throttling" to chained timers — they then fire at most **once per
 * minute**. Firefox and Safari do something similar.
 *
 * That interacts catastrophically with the obvious way to write a cancellable
 * sleep, which is to count down in fixed slices:
 *
 *     for (let left = 60000; left > 0; left -= 250) await sleep(250);
 *
 * Each slice is its own chained timer, so the loop doesn't take 60 seconds in a
 * hidden tab — it takes 240 timers × up to a minute each, which is four hours.
 * The job hasn't crashed and hasn't stopped; it is simply no longer advancing
 * at any rate a person would notice, which looks exactly like a hang.
 *
 * Two things fix it, and both are needed:
 *
 *  1. **Wall-clock deadlines** rather than slice counting, so a slice that
 *     overshoots ends the wait instead of multiplying it. This bounds a wait at
 *     roughly one throttled tick rather than one per slice.
 *  2. **A Web Worker as the timer source.** Timer throttling is applied to a
 *     hidden page's own task queue; a dedicated worker keeps ticking, so the
 *     waits stay honest. Falls back to `setTimeout` wherever Workers aren't
 *     available (tests, SSR), where behaviour is merely the pre-existing one.
 *
 * Note this cannot defeat tab *discarding* — a browser reclaiming memory may
 * unload the page outright. The re-fetch passes checkpoint after every track
 * precisely so that costs a few seconds of repeated work rather than the run.
 */

/** How often a wait wakes up to notice a cancellation. */
const SLICE_MS = 250;

/** A minimal timer server: the whole point is that it is not the main thread. */
const WORKER_SOURCE = `
self.onmessage = function (e) {
  var d = e.data;
  if (!d || typeof d.ms !== 'number') return;
  setTimeout(function () { self.postMessage(d.id); }, d.ms);
};
`;

/** `undefined` = not tried yet, `null` = unavailable, else the worker. */
let worker: Worker | null | undefined;
let nextId = 1;
const pending = new Map<number, () => void>();

function timerWorker(): Worker | null {
  if (worker !== undefined) return worker;
  worker = null;
  try {
    if (
      typeof Worker === 'undefined' ||
      typeof Blob === 'undefined' ||
      typeof URL === 'undefined' ||
      typeof URL.createObjectURL !== 'function'
    ) {
      return worker;
    }
    const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
    const w = new Worker(url);
    URL.revokeObjectURL(url);
    w.onmessage = (e: MessageEvent) => {
      const done = pending.get(e.data as number);
      if (done) {
        pending.delete(e.data as number);
        done();
      }
    };
    w.onerror = () => {
      // Stop trusting it; later sleeps fall back to setTimeout. Anything already
      // waiting is released by its guard below rather than hanging forever.
      worker = null;
      for (const [id, done] of pending) {
        pending.delete(id);
        done();
      }
    };
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

/** Sleeps for `ms`, using the worker clock when one is available. */
export function sleep(ms: number): Promise<void> {
  const w = timerWorker();
  if (!w) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve) => {
    const id = nextId++;
    // Safety net: never let a silent worker failure stall the pipeline.
    const guard = setTimeout(() => {
      if (pending.delete(id)) resolve();
    }, ms + 5000);
    pending.set(id, () => {
      clearTimeout(guard);
      resolve();
    });
    w.postMessage({ id, ms });
  });
}

/** Outcome of a cancellable wait. */
export interface WaitResult {
  /** Wall-clock time actually spent waiting. */
  waited: number;
  /** True when the wait ended early because the job was cancelled. */
  cancelled: boolean;
}

/**
 * Waits `ms`, checking for cancellation about four times a second.
 *
 * The loop is driven by a deadline rather than by counting slices, so a timer
 * that fires late (a throttled background tab, a busy machine, a laptop
 * resuming from sleep) ends the wait instead of extending it — the bug this
 * module exists to prevent.
 */
export async function waitFor(
  ms: number,
  isCancelled?: () => boolean
): Promise<WaitResult> {
  const start = Date.now();
  const deadline = start + ms;
  while (true) {
    if (isCancelled?.()) return { waited: Date.now() - start, cancelled: true };
    const left = deadline - Date.now();
    if (left <= 0) return { waited: Date.now() - start, cancelled: false };
    await sleep(Math.min(left, SLICE_MS));
  }
}

