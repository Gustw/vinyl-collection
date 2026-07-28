import { Track } from './models';
import { Transition, evaluateTransition } from './transitions';

/** A playable route from one record to another, via 0..n bridging records. */
export interface Bridge {
  /** The records to play, starting with the source and ending with the target. */
  path: Track[];
  /** Transitions between consecutive records (path.length - 1 of them). */
  steps: Transition[];
  /** How many records sit between source and target. */
  hops: number;
  /** Sum of the step costs; lower is a smoother route. */
  cost: number;
}

interface Options {
  /** Turntable pitch range, ± percent. */
  pitchRange: number;
  /** Maximum records to insert between source and target. */
  maxBridges: number;
  /** How many routes to return. */
  limit: number;
}

/** Cost of one step; only reachable, harmonic steps are ever considered. */
function stepCost(t: Transition): number {
  let cost = 1; // each extra record is friction in itself
  if (t.percent !== null) cost += Math.abs(t.percent) / 4;
  if (t.level === 'warn') cost += 2;
  if (t.relation === 'Same key') cost -= 0.4;
  return cost;
}

/** A step is usable in a bridge only if it is both playable and in key. */
function usable(t: Transition): boolean {
  return t.harmonic && t.reachable && t.level !== 'bad';
}

/**
 * Finds ways to get from `from` to `to` when they don't mix directly.
 *
 * This is the question that is genuinely hard to answer in your head — "I'm
 * here, I want to get there, what takes me?" — and trivial for a breadth-first
 * search over the compatibility graph. Search is breadth-first so the shortest
 * routes are found first, then results are ranked by smoothness.
 *
 * `pool` should be the records actually available (e.g. the crate you're
 * bringing), since a route through a record you left at home is useless.
 */
export function findBridges(
  from: Track,
  to: Track,
  pool: Track[],
  opts: Options
): Bridge[] {
  const { pitchRange, maxBridges, limit } = opts;
  if (!from.camelot || !to.camelot) return [];

  const candidates = pool.filter(
    (t) => t.camelot && t.id !== from.id && t.id !== to.id
  );

  // Memoised edge evaluation: the same pair is revisited a lot during search.
  const edges = new Map<string, Transition>();
  const edge = (a: Track, b: Track): Transition => {
    const key = `${a.id}>${b.id}`;
    let t = edges.get(key);
    if (!t) {
      t = evaluateTransition(a, b, pitchRange);
      edges.set(key, t);
    }
    return t;
  };

  const results: Bridge[] = [];
  const seenPaths = new Set<string>();

  const record = (path: Track[]): void => {
    const steps: Transition[] = [];
    let cost = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const t = edge(path[i], path[i + 1]);
      steps.push(t);
      cost += stepCost(t);
    }
    const id = path.map((t) => t.id).join('>');
    if (seenPaths.has(id)) return;
    seenPaths.add(id);
    results.push({ path, steps, hops: path.length - 2, cost });
  };

  // Direct mix first — if it works, no bridge is needed at all.
  if (usable(edge(from, to))) record([from, to]);

  /**
   * Beam width. An exhaustive search is O(candidates^depth), which on a few
   * thousand records would lock up the browser, so each level keeps only the
   * most promising partial routes. We only need a handful of good answers,
   * not every answer.
   */
  const BEAM = 40;

  // Breadth-first over increasing numbers of bridging records, best-first
  // within each level.
  let frontier: { path: Track[]; cost: number }[] = [{ path: [from], cost: 0 }];
  for (let depth = 1; depth <= maxBridges; depth++) {
    const next: { path: Track[]; cost: number }[] = [];
    for (const node of frontier) {
      const last = node.path[node.path.length - 1];
      for (const mid of candidates) {
        if (node.path.includes(mid)) continue; // never play the same record twice
        const step = edge(last, mid);
        if (!usable(step)) continue;
        const extended = [...node.path, mid];
        if (usable(edge(mid, to))) record([...extended, to]);
        next.push({ path: extended, cost: node.cost + stepCost(step) });
      }
    }
    if (results.length >= limit) break; // shorter routes already found
    next.sort((a, b) => a.cost - b.cost);
    frontier = next.slice(0, BEAM);
    if (!frontier.length) break;
  }

  // Fewest records first, then smoothest.
  results.sort((a, b) => (a.hops === b.hops ? a.cost - b.cost : a.hops - b.hops));
  return results.slice(0, limit);
}

