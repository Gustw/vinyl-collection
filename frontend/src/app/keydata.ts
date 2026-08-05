/**
 * Choosing where a key/BPM comes from.
 *
 * Beatport is asked first and tunebat only when Beatport has nothing. The order
 * is not arbitrary: Beatport publishes the label's own metadata (and keeps the
 * mix name as its own field, which is what makes a "Dub Mix" distinguishable
 * from the plain cut), whereas tunebat infers key and tempo by analysing an
 * audio upload. Where both have a record, Beatport is the better answer; where
 * Beatport doesn't — vinyl-only jungle, dubplates, white labels, anything
 * predating digital distribution, which is most of this collection — tunebat is
 * the only answer there is.
 *
 * "Nothing" means neither a key nor a BPM came back. A Beatport reply that was
 * merely *unconvincing* counts as nothing too: the match checker having
 * rejected every hit is precisely the case where the second opinion is worth
 * having.
 */

import { AppConfig } from './config.service';
import { cachedBeatportInfo, lookupKeyBeatport } from './beatport';
import { cachedKeyInfo, lookupKey } from './tunebat';
import { KeyInfo, LookupOptions, hasAnswer } from './keyinfo';

export type { KeyInfo, LookupOptions, KeySource } from './keyinfo';

/**
 * The best answer available for a track: Beatport's if it has one, else
 * tunebat's. Cancellation is honoured between the two, so a stopped job doesn't
 * start a second request it will only throw away.
 */
export async function lookupKeyData(
  cfg: AppConfig,
  artist: string,
  title: string,
  opts: LookupOptions = {}
): Promise<KeyInfo> {
  const beatport = await lookupKeyBeatport(cfg, artist, title, opts);
  if (hasAnswer(beatport)) return beatport;
  if (opts.isCancelled?.()) return beatport;

  const tunebat = await lookupKey(cfg, artist, title, opts);
  // Beatport's (empty) reply may still be carrying a previously known key
  // forward, so prefer whichever of the two actually says something.
  return hasAnswer(tunebat) ? tunebat : hasAnswer(beatport) ? beatport : tunebat;
}

/**
 * The cached answer for a track from either source, preferring Beatport.
 * Used to restore in-flight progress after a page reload.
 */
export function cachedKeyInfoAny(artist: string, title: string): KeyInfo | null {
  const beatport = cachedBeatportInfo(artist, title);
  if (hasAnswer(beatport)) return beatport;
  const tunebat = cachedKeyInfo(artist, title);
  return hasAnswer(tunebat) ? tunebat : beatport ?? tunebat;
}

