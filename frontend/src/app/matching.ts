/**
 * Deciding whether a search hit is actually the track we asked for.
 *
 * tunebat's search is a fuzzy relevance query: it returns *something* for
 * almost any input. Taking the first hit on trust — which is what this app and
 * the Java tool before it used to do — silently records a different song's key
 * and BPM whenever a pressing isn't in tunebat's catalogue. That is common for
 * vinyl-only jungle and dub 12"s, and it is invisible afterwards because the
 * matched track's identity was never kept.
 *
 * So every candidate is scored against what was asked for, on three axes:
 *
 *   artist  — token overlap, tolerant of "Featuring"/"&"/word order and of
 *             small spelling drift ("U.K Apachi" vs "UK Apache")
 *   title   — the title with its bracketed notes removed
 *   version — the bracketed note itself ("Dub Mix", "Benny Page Remix"), which
 *             names a *different recording* and must therefore agree
 *
 * A candidate that fails any of the three is rejected outright. For a mixing
 * tool a wrong BPM is worse than a missing one: a missing key just drops the
 * track out of the mixable list, while a wrong one makes every bridge and
 * transition built on it quietly false.
 */

/** Folds case, strips diacritics and punctuation, collapses whitespace. */
export function normalise(s: string): string {
  return (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // combining accents
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Words that say how artists relate rather than who they are. */
const ARTIST_NOISE = new Set([
  'feat', 'featuring', 'ft', 'with', 'vs', 'versus', 'and', 'presents', 'pres',
  'meets', 'the', 'a', 'of',
]);

/** Words that appear in almost every version note and so distinguish nothing. */
const VERSION_NOISE = new Set(['mix', 'the', 'a', 'an', 'of']);

/**
 * Bracketed notes that name the canonical recording rather than a different
 * one. "(Original Mix)" and a bare title are the same record; "(Dub Mix)" is
 * not. Deliberately short — anything not listed counts as significant, so an
 * unfamiliar note errs towards rejecting a doubtful match.
 */
const CANONICAL_VERSION =
  /^(original|original mix|original version|album version|lp version|radio edit|radio version|single version|full length)$/;

/** A bracketed note that names extra performers, e.g. "(feat. Tippa Irie)". */
const FEATURE_NOTE = /^(feat|ft|featuring|with)\b/;

export function tokens(s: string, drop?: Set<string>): string[] {
  const out = normalise(s).split(' ').filter(Boolean);
  return drop ? out.filter((t) => !drop.has(t)) : out;
}

function bigrams(s: string): string[] {
  const t = s.replace(/\s+/g, '');
  const out: string[] = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}

/**
 * Sørensen–Dice similarity over character bigrams, 0..1. Cheap, order-tolerant
 * and good at the kind of drift that separates two spellings of one name.
 */
export function dice(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.length || !B.length) return 0;
  const counts = new Map<string, number>();
  for (const g of A) counts.set(g, (counts.get(g) ?? 0) + 1);
  let hits = 0;
  for (const g of B) {
    const n = counts.get(g) ?? 0;
    if (n > 0) {
      counts.set(g, n - 1);
      hits++;
    }
  }
  return (2 * hits) / (A.length + B.length);
}

/**
 * Whether two tokens are the same word. Short tokens ("uk", "dj", "mc") must
 * match exactly — bigram similarity is far too generous at that length.
 */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  return dice(a, b) >= 0.8;
}

/**
 * How much of the shorter token list is present in the longer one, 0..1.
 * Containment rather than symmetric overlap, because the two sources routinely
 * disagree about how many artists to credit.
 */
export function tokenScore(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const [small, big] = a.length <= b.length ? [a, b] : [b, a];
  const used = new Set<number>();
  let hits = 0;
  for (const t of small) {
    for (let i = 0; i < big.length; i++) {
      if (used.has(i)) continue;
      if (sameWord(big[i], t)) {
        used.add(i);
        hits++;
        break;
      }
    }
  }
  return hits / small.length;
}

/** How many tokens of `a` have a partner in `b` (each partner used once). */
function overlapCount(a: string[], b: string[]): number {
  const used = new Set<number>();
  let hits = 0;
  for (const t of a) {
    for (let i = 0; i < b.length; i++) {
      if (used.has(i)) continue;
      if (sameWord(b[i], t)) {
        used.add(i);
        hits++;
        break;
      }
    }
  }
  return hits;
}

/**
 * Symmetric token agreement (F1), 0..1.
 *
 * Titles are scored symmetrically rather than by containment, because for a
 * title an unmatched word on *either* side is evidence of a different song.
 * Containment only asks whether the shorter list is covered, which is why
 * "Pass Me The Rizla" scored 0.75 against "Pass Me The Dubplate" and was
 * accepted: three of four words agreed and the fourth — the only one carrying
 * any meaning — was ignored. F1 penalises the leftover on both sides.
 *
 * Artists keep containment (see tokenScore): there the two sources genuinely
 * disagree about how many people to credit, and that is not evidence of a
 * different record.
 */
export function symmetricTokenScore(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const hits = overlapCount(a, b);
  if (!hits) return 0;
  const precision = hits / a.length;
  const recall = hits / b.length;
  return (2 * precision * recall) / (precision + recall);
}

/**
 * Numbers in a title, which almost always name a different record rather than
 * a spelling variant: "Original Nuttah" vs "Original Nuttah 25", "Volume 4"
 * vs "Volume 5", "Warehouse 2" vs "Warehouse". Beatport's catalogue is full of
 * anniversary re-records and numbered volumes, and a token-overlap score barely
 * notices a one-token difference, so digits are compared separately and
 * strictly.
 */
function numericTokens(s: string): string[] {
  return tokens(s)
    .filter((t) => /^\d+$/.test(t))
    .sort();
}

/** True when both titles carry the same numbers (in any order). */
function numbersAgree(a: string, b: string): boolean {
  const na = numericTokens(a);
  const nb = numericTokens(b);
  return na.length === nb.length && na.every((v, i) => v === nb[i]);
}

/** Title words too common to distinguish one record from another. */
const TITLE_NOISE = new Set([
  'the', 'a', 'an', 'of', 'and', 'to', 'in', 'on', 'my', 'me', 'you', 'it',
  'is', 'be', 'do', 'we', 'us', 'im', 'its', 'for', 'up', 'go', 'no', 'so',
]);

/**
 * The words in a title that actually identify it: long enough to mean
 * something, and not a grammatical filler.
 */
function distinctiveTitleWords(title: string): string[] {
  return tokens(title).filter((t) => t.length >= 4 && !TITLE_NOISE.has(t));
}

/**
 * True when neither title has a meaningful word the other lacks.
 *
 * A proportional score cannot separate "Pass Me The Dubplate" from "Pass Me The
 * Rizla": three words of four agree, which reads as 0.75 — comfortably above
 * any sane threshold — even though the single word that names the record is
 * different. Short, common words carry almost no identifying information, so
 * agreement is judged on the words that do. An unmatched distinctive word on
 * either side means these are two different records.
 */
function distinctiveWordsAgree(want: string, got: string): boolean {
  const a = distinctiveTitleWords(want);
  const b = distinctiveTitleWords(got);
  // Nothing distinctive on either side (e.g. "Go" vs "Go On"): fall back to the
  // proportional score rather than declaring a match on no evidence.
  if (!a.length || !b.length) return true;
  const matches = (x: string[], y: string[]) =>
    x.every((t) => y.some((u) => sameWord(t, u)));
  return matches(a, b) && matches(b, a);
}

/** A title broken into the parts that identify different things. */
export interface TitleParts {
  /** The title with every bracketed note removed. */
  base: string;
  /** Bracketed notes that name a different recording. */
  versions: string[];
  /** Bracketed notes that name extra performers. */
  featured: string[];
}

const BRACKETED = /[([]([^)\]]*)[)\]]/g;

/** Splits "Bad Boys (feat. X) (Benny Page Remix)" into its parts. */
export function splitTitle(title: string): TitleParts {
  const versions: string[] = [];
  const featured: string[] = [];
  const base = (title || '')
    .replace(BRACKETED, (_, inner: string) => {
      const text = String(inner).trim();
      if (!text) return ' ';
      if (FEATURE_NOTE.test(normalise(text))) featured.push(text);
      else versions.push(text);
      return ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();
  return { base: base || (title || '').trim(), versions, featured };
}

/** True when a bracketed note names a different recording, not the canonical one. */
export function isSignificantVersion(note: string): boolean {
  const n = normalise(note);
  return !!n && !CANONICAL_VERSION.test(n);
}

/** The words in a version note that actually distinguish it. */
function versionKeywords(note: string): string[] {
  return tokens(note, VERSION_NOISE);
}

/** What we asked tunebat for. */
export interface MatchQuery {
  artist: string;
  title: string;
}

/** A single search hit, reduced to the parts we can judge. */
export interface Candidate {
  name: string;
  artists: string[];
}

/** Why a candidate was accepted or rejected. */
export interface MatchScore {
  artist: number;
  title: number;
  versionOk: boolean;
  /** Combined 0..1 confidence, for ranking accepted candidates. */
  score: number;
  accepted: boolean;
  reason: string;
}

/**
 * Both sides must agree about which recording this is — in both directions.
 *
 * A remix asked for and not offered is a miss; so is the reverse, being handed
 * a remix when the plain track was wanted. So is being handed a *different*
 * remix: "Bad Boys (Benny Page ft. Kursiva Remix)" is not "Bad Boys (Benny Page
 * Remix)", and checking only that the asked-for words appear somewhere in the
 * candidate accepts it, because "benny", "page" and "remix" all do. The extra
 * words have to be accounted for too.
 */
function versionAgrees(want: TitleParts, candidateName: string): boolean {
  const got = splitTitle(candidateName);
  const wanted = want.versions.filter(isSignificantVersion);
  const offered = got.versions.filter(isSignificantVersion);

  if (!wanted.length) {
    // Asked for the plain track: a candidate advertising a remix is a different
    // recording, so it can't stand in.
    return !offered.length;
  }

  // Every distinguishing word we asked for has to be recognisable in the
  // candidate's name — sources write versions as "(Dub Mix)", "- Dub Mix" or
  // plain suffixes, so the whole name is searched rather than just its brackets.
  const haystack = tokens(candidateName);
  const wantedKeywords = wanted.flatMap(versionKeywords);
  const allPresent = wantedKeywords.every((k) => haystack.some((h) => sameWord(h, k)));
  if (!allPresent) return false;

  // …and the candidate must not name anything extra that we didn't ask for.
  // Only its own version notes are examined: words elsewhere in the title are
  // the title, not the version.
  const offeredKeywords = offered.flatMap(versionKeywords);
  return offeredKeywords.every((k) => wantedKeywords.some((w) => sameWord(w, k)));
}

/** Minimum artist agreement before a hit can be considered at all. */
export const MIN_ARTIST = 0.6;
/** Minimum agreement on the title once bracketed notes are set aside. */
export const MIN_TITLE = 0.7;

/** Scores one candidate against the query, and says whether it is acceptable. */
export function scoreCandidate(query: MatchQuery, candidate: Candidate): MatchScore {
  const want = splitTitle(query.title);

  // Performers credited in the title belong with the artist for matching.
  const queryArtist = tokens(
    [query.artist, ...want.featured].join(' '),
    ARTIST_NOISE
  );
  const candArtist = tokens(candidate.artists.join(' '), ARTIST_NOISE);
  const candParts = splitTitle(candidate.name);
  const candArtistAll = candArtist.length
    ? candArtist
    : tokens(candParts.featured.join(' '), ARTIST_NOISE);

  const artist = tokenScore(queryArtist, candArtistAll);

  const wantBase = normalise(want.base);
  const gotBase = normalise(candParts.base);
  // Symmetric token agreement handles reordering and punishes leftover words on
  // either side; bigram similarity rescues short titles where a single token
  // difference would swamp the score. The weaker of the two is not used — the
  // stronger is, so a genuine spelling variant still passes.
  const title = Math.max(
    symmetricTokenScore(tokens(want.base), tokens(candParts.base)),
    dice(wantBase, gotBase)
  );

  const versionOk = versionAgrees(want, candidate.name);
  const numbersOk = numbersAgree(want.base, candParts.base);
  const wordsOk = distinctiveWordsAgree(want.base, candParts.base);
  const score = 0.45 * artist + 0.45 * title + 0.1 * (versionOk ? 1 : 0);

  let reason = 'ok';
  let accepted = true;
  if (!candidate.name) {
    accepted = false;
    reason = 'candidate has no readable title';
  } else if (artist < MIN_ARTIST) {
    accepted = false;
    reason = `artist mismatch (${artist.toFixed(2)} < ${MIN_ARTIST})`;
  } else if (title < MIN_TITLE) {
    accepted = false;
    reason = `title mismatch (${title.toFixed(2)} < ${MIN_TITLE})`;
  } else if (!wordsOk) {
    accepted = false;
    reason = 'a distinctive word in the title differs';
  } else if (!numbersOk) {
    accepted = false;
    reason = 'different number in the title (e.g. a numbered volume or re-record)';
  } else if (!versionOk) {
    accepted = false;
    reason = 'different version/mix';
  }

  return { artist, title, versionOk, score, accepted, reason };
}

/** The chosen hit, plus why — or why nothing was chosen. */
export interface MatchResult<T> {
  item: T | null;
  candidate: Candidate | null;
  score: MatchScore | null;
  /** Human explanation, for logging and for the "no match" case. */
  reason: string;
}

/**
 * Picks the best acceptable hit from a search result list, or none.
 *
 * Candidates are ranked by combined confidence rather than by tunebat's own
 * relevance order, so an exact version match further down the list wins over a
 * near-miss at the top.
 */
export function pickBestMatch<T>(
  query: MatchQuery,
  items: T[],
  toCandidate: (item: T) => Candidate
): MatchResult<T> {
  let best: MatchResult<T> = { item: null, candidate: null, score: null, reason: 'no results' };
  let bestScore = -1;
  const rejections: string[] = [];

  for (const item of items) {
    const candidate = toCandidate(item);
    const score = scoreCandidate(query, candidate);
    if (!score.accepted) {
      if (rejections.length < 3 && candidate.name) {
        rejections.push(`"${candidate.name}" — ${score.reason}`);
      }
      continue;
    }
    if (score.score > bestScore) {
      bestScore = score.score;
      best = { item, candidate, score, reason: 'matched' };
    }
  }

  if (!best.item && items.length) {
    best.reason = rejections.length
      ? `no acceptable match (${rejections.join('; ')})`
      : 'no acceptable match';
  }
  return best;
}

