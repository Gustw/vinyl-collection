import { Track } from './models';
import { Transition, evaluateTransitionAt } from './transitions';
import {
  TempoWindow,
  clampToWindow,
  foldBpmTo,
  intersectWindows,
  pitchToTempo,
  semitonesToTempo,
  shiftCamelot,
  tempoWindow,
} from './camelot';

/** One record of a route, with the tempo and key it actually plays at. */
export interface RouteRecord {
  track: Track;
  /** The record's BPM restated in the route's octave (null when unknown). */
  bpm: number | null;
  /** Tempo it is mixed in at; for the first record, its own tempo. */
  entryTempo: number | null;
  /** Tempo it is running at when the next record comes in. */
  exitTempo: number | null;
  /** Fader position when it comes in, in percent. */
  entryPitch: number | null;
  /** Fader position when it goes out, in percent. */
  exitPitch: number | null;
  /** Camelot code it sounds in when it comes in. */
  entryCamelot: string;
  /** Camelot code it sounds in when it goes out. */
  exitCamelot: string;
}

/** A playable route from one record to another, via 0..n bridging records. */
export interface Bridge {
  /** The records to play, starting with the source and ending with the target. */
  path: Track[];
  /** The same records, with the tempo and pitch each one is played at. */
  records: RouteRecord[];
  /** Transitions between consecutive records (path.length - 1 of them). */
  steps: Transition[];
  /** How many records sit between source and target. */
  hops: number;
  /** Sum of the step costs; lower is a smoother route. */
  cost: number;
  /** The largest fader position the route asks for anywhere, in percent. */
  maxPitch: number;
  /** Where the set tempo ends up relative to where it started, in percent. */
  tempoShift: number;
  /** Tempo the route starts and ends at (null when BPMs are unknown). */
  startTempo: number | null;
  endTempo: number | null;
}

export interface Options {
  /** Turntable pitch range, ± percent. */
  pitchRange: number;
  /** Maximum records to insert between source and target. */
  maxBridges: number;
  /** How many routes to return. */
  limit: number;
  /**
   * How far the set tempo is allowed to wander from the starting record's own
   * tempo over the whole route, in ± percent. 0 locks the set to one tempo;
   * raising it lets the route ride the tempo up or down through the bridges,
   * which is what makes distant BPMs reachable at all. Defaults to the deck's
   * pitch range.
   */
  tempoDrift?: number;
}

/** Everything about a candidate record that the search needs, precomputed once. */
interface Node {
  track: Track;
  /** BPM folded into the source record's octave, or null when unknown. */
  bpm: number | null;
  /** Tempos this record can be played at on these decks. */
  window: TempoWindow;
}

const ANY_TEMPO: TempoWindow = { lo: 0, hi: Number.POSITIVE_INFINITY };

/** Cost of one step; only reachable, harmonic steps are ever considered. */
function stepCost(t: Transition): number {
  let cost = 1; // each extra record is friction in itself
  const strain = Math.max(Math.abs(t.percent ?? 0), Math.abs(t.fromPercent ?? 0));
  cost += strain / 4;
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
 * Tempo is modelled explicitly rather than pair by pair. Every record is folded
 * into the starting record's octave, so the whole route shares one tempo scale,
 * and each record carries the window of tempos its pitch fader can actually
 * reach. A mix is possible only where the two records' windows overlap — and
 * the overlap must also sit inside the drift the set is allowed. Because the
 * record you are mixing *out* of is itself already pitched, that overlap, not
 * a fresh ±range around its printed BPM, is what decides reachability, and the
 * key each record sounds in is taken at the tempo the blend actually happens at.
 */
export function findBridges(
  from: Track,
  to: Track,
  pool: Track[],
  opts: Options
): Bridge[] {
  const { pitchRange, maxBridges, limit } = opts;
  const drift = opts.tempoDrift ?? pitchRange;
  if (!from.camelot || !to.camelot) return [];

  // Everything is measured against the tempo the starting record is playing at.
  const rawSource = parseFloat(from.bpm);
  const sourceTempo = rawSource > 0 ? rawSource : null;

  /** The tempos the set as a whole is allowed to run at. */
  const allowed: TempoWindow =
    sourceTempo !== null ? tempoWindow(sourceTempo, drift) : ANY_TEMPO;

  const node = (t: Track): Node => {
    const raw = parseFloat(t.bpm);
    const bpm = sourceTempo !== null && raw > 0 ? foldBpmTo(raw, sourceTempo) : null;
    return {
      track: t,
      bpm,
      // A record with no BPM can't be checked, so it constrains nothing.
      window: bpm !== null ? tempoWindow(bpm, pitchRange) : ANY_TEMPO,
    };
  };

  const source = node(from);
  const target = node(to);
  const candidates = pool
    .filter((t) => t.camelot && t.id !== from.id && t.id !== to.id)
    .map(node)
    // A record the decks can never hold at any allowed set tempo is no use.
    .filter((n) => intersectWindows(n.window, allowed) !== null);

  // Memoised edge evaluation: the same pair is revisited a lot during search.
  // The blend tempo depends only on the pair, so caching by pair stays correct.
  const edges = new Map<string, Transition>();
  const edge = (a: Node, b: Node): Transition => {
    const key = `${a.track.id}>${b.track.id}`;
    let t = edges.get(key);
    if (!t) {
      t = evaluateTransitionAt(
        a.track,
        b.track,
        { fromBpm: a.bpm, toBpm: b.bpm, mixTempo: mixTempo(a, b) },
        pitchRange
      );
      edges.set(key, t);
    }
    return t;
  };

  /**
   * The tempo to blend `a` into `b` at: the tempo that splits the pitch each
   * deck has to do (the geometric mean of the two BPMs), pulled back into the
   * window both records — and the set's drift allowance — can actually reach.
   * Null when the pair simply cannot meet.
   */
  function mixTempo(a: Node, b: Node): number | null {
    const both = intersectWindows(a.window, b.window);
    if (!both) return null;
    const feasible = intersectWindows(both, allowed);
    if (!feasible) return null;
    if (a.bpm === null || b.bpm === null) return sourceTempo;
    return clampToWindow(Math.sqrt(a.bpm * b.bpm), feasible);
  }

  const results: Bridge[] = [];
  const seenPaths = new Set<string>();

  const record = (path: Node[]): void => {
    const id = path.map((n) => n.track.id).join('>');
    if (seenPaths.has(id)) return;
    seenPaths.add(id);

    const steps: Transition[] = [];
    let cost = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const t = edge(path[i], path[i + 1]);
      steps.push(t);
      cost += stepCost(t);
    }

    const records = describe(path, steps, sourceTempo);
    const maxPitch = records.reduce(
      (m, r) => Math.max(m, Math.abs(r.entryPitch ?? 0), Math.abs(r.exitPitch ?? 0)),
      0
    );
    const startTempo = records[0]?.entryTempo ?? null;
    const endTempo = records[records.length - 1]?.entryTempo ?? null;
    const tempoShift =
      startTempo !== null && endTempo !== null ? (endTempo / startTempo - 1) * 100 : 0;

    // Riding the tempo a long way and pinning a fader to its stop are both
    // real costs, even when every individual step checks out.
    cost += maxPitch / 8 + Math.abs(tempoShift) / 8;

    results.push({
      path: path.map((n) => n.track),
      records,
      steps,
      hops: path.length - 2,
      cost,
      maxPitch,
      tempoShift,
      startTempo,
      endTempo,
    });
  };

  // Direct mix first — if it works, no bridge is needed at all.
  if (usable(edge(source, target))) record([source, target]);

  /**
   * Beam width. An exhaustive search is O(candidates^depth), which on a few
   * thousand records would lock up the browser, so each level keeps only the
   * most promising partial routes. We only need a handful of good answers,
   * not every answer.
   */
  const BEAM = 40;

  // Breadth-first over increasing numbers of bridging records, best-first
  // within each level.
  let frontier: { path: Node[]; cost: number }[] = [{ path: [source], cost: 0 }];
  for (let depth = 1; depth <= maxBridges; depth++) {
    const next: { path: Node[]; cost: number }[] = [];
    for (const n of frontier) {
      const last = n.path[n.path.length - 1];
      for (const mid of candidates) {
        if (n.path.includes(mid)) continue; // never play the same record twice
        const step = edge(last, mid);
        if (!usable(step)) continue;
        const extended = [...n.path, mid];
        if (usable(edge(mid, target))) record([...extended, target]);
        next.push({ path: extended, cost: n.cost + stepCost(step) });
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

/**
 * Turns a finished path into the per-record view: where each fader sits when
 * the record comes in, where it has been ridden to by the time it goes out,
 * and the key it sounds in at each of those points.
 *
 * A record enters at the tempo of the blend that brought it in and leaves at
 * the tempo of the blend that takes it out, so the tempo the set is running at
 * accumulates along the route instead of resetting at every record.
 */
function describe(
  path: Node[],
  steps: Transition[],
  sourceTempo: number | null
): RouteRecord[] {
  return path.map((n, i) => {
    const entryTempo = i === 0 ? n.bpm ?? sourceTempo : steps[i - 1]?.mixTempo ?? null;
    const exitTempo = i < steps.length ? steps[i].mixTempo ?? entryTempo : entryTempo;
    const at = (tempo: number | null) => {
      if (n.bpm === null || tempo === null) {
        return { pitch: null as number | null, camelot: n.track.camelot };
      }
      return {
        pitch: pitchToTempo(n.bpm, tempo),
        camelot: shiftCamelot(n.track.camelot, semitonesToTempo(n.bpm, tempo)),
      };
    };
    const entry = at(entryTempo);
    const exit = at(exitTempo);
    return {
      track: n.track,
      bpm: n.bpm,
      entryTempo,
      exitTempo,
      entryPitch: entry.pitch,
      exitPitch: exit.pitch,
      entryCamelot: entry.camelot,
      exitCamelot: exit.camelot,
    };
  });
}
