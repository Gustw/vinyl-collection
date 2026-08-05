/**
 * Checks the Beatport client and the match rules against fixtures in the shape
 * Beatport *actually* serves.
 *
 * The first version of this file invented its own schema, so it passed happily
 * while the real integration matched nothing at all. The `row` fixture below is
 * a trimmed copy of a genuine search-index result (note `track_name`,
 * `artist_name`, the flat `key_name`, and the absence of any camelot field);
 * `catalogRow` covers the documented shape, since the client has to read both.
 *
 * Run with: npm run check:beatport
 */
import { lookupKeyBeatport } from '../src/app/beatport';
import { lookupKeyData } from '../src/app/keydata';
import { defaultConfig } from '../src/app/config.service';
import { scoreCandidate } from '../src/app/matching';
import {
  CAMELOT_CODES,
  camelotOfQuery,
  camelotToKeyName,
  keyNameToCamelot,
  sameKeyName,
} from '../src/app/camelot';
import { normaliseKeyName } from '../src/app/keyinfo';

// --- stubs ---------------------------------------------------------------

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

type Route = (url: string) => { status?: number; body: any; text?: boolean } | null;
let routes: Route[] = [];
let calls: string[] = [];

(globalThis as any).fetch = async (url: string) => {
  calls.push(url);
  for (const r of routes) {
    const hit = r(url);
    if (hit) {
      const status = hit.status ?? 200;
      return {
        status,
        headers: { get: () => null },
        json: async () => hit.body,
        text: async () => (hit.text ? hit.body : JSON.stringify(hit.body)),
      } as any;
    }
  }
  throw new Error('network blocked: ' + url);
};

function target(url: string): string {
  const i = url.indexOf('?url=');
  return i >= 0 ? decodeURIComponent(url.slice(i + 5)) : url;
}

const cfg = { ...defaultConfig(), corsProxy: 'https://proxy.test/?url=' };
const withToken = { ...cfg, beatportToken: 'tok' };

// --- fixtures ------------------------------------------------------------

/** A row as Beatport's search index really returns it. */
const row = (o: any) => ({
  score: o.score ?? 100,
  track_id: o.id ?? 1,
  track_name: o.name,
  mix_name: o.mix_name ?? 'Original Mix',
  artists: (o.artists ?? []).map((n: string, i: number) => ({
    artist_id: i + 1,
    artist_name: n,
    artist_type_name: 'Artist',
  })),
  bpm: o.bpm,
  key_name: o.key_name,
  key_id: 3,
  genre: (o.genres ?? ['Drum & Bass']).map((g: string, i: number) => ({
    genre_id: i + 1,
    genre_name: g,
  })),
  release: { release_id: 9, release_name: 'Some Release' },
});

/** A row in the documented catalog shape, which the client must also read. */
const catalogRow = (o: any) => ({
  id: o.id ?? 1,
  name: o.name,
  mix_name: o.mix_name ?? 'Original Mix',
  artists: (o.artists ?? []).map((n: string) => ({ id: 1, name: n })),
  remixers: (o.remixers ?? []).map((n: string) => ({ id: 2, name: n })),
  bpm: o.bpm,
  key: o.key,
  genre: { id: 5, name: o.genre ?? 'House' },
});

// --- assertions ----------------------------------------------------------

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}\n         expected ${e}\n         actual   ${a}`);
  }
}

function reset(newRoutes: Route[]) {
  store.clear();
  calls = [];
  routes = newRoutes;
}

const api = (tracks: any[]): Route => (url) =>
  target(url).startsWith('https://api.beatport.com/v4/catalog/search')
    ? { body: { tracks: { data: tracks } } }
    : null;

/** The SSR blob, nested exactly where Beatport puts it. */
const web = (tracks: any[]): Route => (url) =>
  target(url).startsWith('https://www.beatport.com/search/tracks')
    ? {
        text: true,
        body:
          `<html><body><script id="__NEXT_DATA__" type="application/json">` +
          JSON.stringify({
            props: {
              pageProps: {
                dehydratedState: {
                  queries: [
                    { queryKey: ['search-tracks'], state: { data: { data: tracks } } },
                  ],
                },
              },
            },
          }) +
          `</script></body></html>`,
      }
    : null;

const accepts = (
  artist: string,
  title: string,
  cand: { name: string; artists: string[] }
) => scoreCandidate({ artist, title }, cand).accepted;

// --- the checks ----------------------------------------------------------

async function main() {
  console.log('\nKey name -> camelot (enharmonics included)');
  check('Bb minor', keyNameToCamelot('Bb minor'), '3A');
  check('A# minor is the same wheel slot', keyNameToCamelot('A# minor'), '3A');
  check('A minor', keyNameToCamelot('A minor'), '8A');
  check('C major', keyNameToCamelot('C major'), '8B');
  check('G major', keyNameToCamelot('G major'), '9B');
  check('Ab minor', keyNameToCamelot('Ab minor'), '1A');
  check('unreadable mode refused', keyNameToCamelot('A'), '');

  console.log('\nEvery wheel position survives a round trip');
  {
    const bad: string[] = [];
    for (const code of CAMELOT_CODES) {
      const name = camelotToKeyName(code);
      if (!name || keyNameToCamelot(name) !== code) bad.push(`${code} -> "${name}"`);
    }
    check('all 24 canonical names map back to their code', bad, []);
  }

  console.log('\nBoth spellings of every black key agree');
  {
    // Each pair names one key; both must land on the same wheel position, in
    // both modes. This is the property that stops "A# minor" and "Bb minor"
    // being treated as a correction of one another.
    const pairs: Array<[string, string]> = [
      ['A#', 'Bb'], ['C#', 'Db'], ['D#', 'Eb'], ['F#', 'Gb'], ['G#', 'Ab'],
      // White-key accidentals, rare but legal.
      ['B#', 'C'], ['E#', 'F'], ['Cb', 'B'], ['Fb', 'E'],
    ];
    const bad: string[] = [];
    for (const [sharp, flat] of pairs) {
      for (const mode of ['minor', 'major']) {
        const a = keyNameToCamelot(`${sharp} ${mode}`);
        const b = keyNameToCamelot(`${flat} ${mode}`);
        if (!a || a !== b) bad.push(`${sharp} ${mode} = ${a || '??'} but ${flat} ${mode} = ${b || '??'}`);
        if (!sameKeyName(`${sharp} ${mode}`, `${flat} ${mode}`)) {
          bad.push(`sameKeyName says ${sharp} ${mode} != ${flat} ${mode}`);
        }
      }
    }
    check('every enharmonic pair agrees', bad, []);
  }

  console.log('\nKey spellings actually present in tracks.txt all parse');
  {
    // The 24 spellings the collection really uses (audited from the file).
    const inUse = [
      'G major', 'C# major', 'D major', 'C major', 'B minor', 'E minor',
      'A minor', 'A# minor', 'A major', 'C# minor', 'F minor', 'Ab major',
      'F major', 'E major', 'F# minor', 'F# major', 'B major', 'G# minor',
      'Bb major', 'G minor', 'D minor', 'C minor', 'Eb major', 'D# minor',
    ];
    check('all parse to a code', inUse.filter((k) => !keyNameToCamelot(k)), []);
  }

  console.log('\nEnharmonic equality (the anti-churn rule)');
  check('A# minor == Bb minor', sameKeyName('A# minor', 'Bb minor'), true);
  check('C# major == Db major', sameKeyName('C# major', 'Db major'), true);
  check('F# minor == Gb minor', sameKeyName('F# minor', 'Gb minor'), true);
  check('A minor != A major', sameKeyName('A minor', 'A major'), false);
  check('A minor != Bb minor', sameKeyName('A minor', 'Bb minor'), false);
  check('unparseable equals itself', sameKeyName('Weird', 'Weird'), true);

  console.log('\nKey names are read in every spelling sources use');
  check('unicode flat', normaliseKeyName('A\u266d Minor'), 'Ab minor');
  check('unicode sharp', normaliseKeyName('F\u266f Major'), 'F# major');
  check('beatport short form', normaliseKeyName('Bb Min'), 'Bb minor');
  check('beatport short major', normaliseKeyName('F Maj'), 'F major');
  check('bare m suffix', normaliseKeyName('Ebm'), 'Eb minor');
  check('written-out flat', normaliseKeyName('A flat minor'), 'Ab minor');
  check('written-out sharp', normaliseKeyName('D sharp minor'), 'D# minor');
  check('written-out forms reach the wheel', keyNameToCamelot(normaliseKeyName('A flat minor')), '1A');

  console.log('\nSearching by key finds it however the track spells it');
  check('name -> code', camelotOfQuery('Bb minor'), '3A');
  check('other spelling -> same code', camelotOfQuery('A# minor'), '3A');
  check('a bare code is understood', camelotOfQuery('8a'), '8A');
  check('plain words are not keys', camelotOfQuery('jungle'), '');

  console.log('\nBeatport: reads the real search-index shape');
  reset([
    web([
      row({ id: 1, name: 'Greece 2000', artists: ['Sunset Regime'], bpm: 174, key_name: 'F Maj', genres: ['Trance'] }),
      row({ id: 2, name: 'Greece 2000', artists: ['Three Drives'], bpm: 132, key_name: 'Ab Minor', genres: ['Trance'] }),
    ]),
  ]);
  let r = await lookupKeyBeatport(cfg, 'Three Drives', 'Greece 2000');
  check('bpm', r.bpm, '132');
  check('key name normalised', r.keyName, 'Ab minor');
  check('camelot derived (index has none)', r.camelot, '1A');
  check('key text', r.keyText, 'Ab minor (1A)');
  check('source', r.source, 'beatport');

  console.log('\nBeatport: still reads the documented catalog shape');
  reset([
    api([
      catalogRow({
        id: 7,
        name: 'Greece 2000',
        artists: ['Three Drives'],
        bpm: 132,
        key: { id: 16, name: 'A min', camelot: '8A' },
      }),
    ]),
  ]);
  r = await lookupKeyBeatport(withToken, 'Three Drives', 'Greece 2000');
  check('bpm', r.bpm, '132');
  check('camelot taken directly', r.camelot, '8A');
  check('key name', r.keyName, 'A minor');

  console.log('\nBeatport: half-time drum & bass is converted to played tempo');
  reset([
    web([row({ id: 1, name: 'Jungle Souljah', artists: ['Congo Natty'], bpm: 83, key_name: 'Ab Minor', genres: ['Drum & Bass', 'Jungle'] })]),
  ]);
  r = await lookupKeyBeatport(cfg, 'Congo Natty', 'Jungle Souljah');
  check('83 doubled to 166', r.bpm, '166');

  console.log('\nBeatport: a slow house track is left alone');
  reset([
    web([row({ id: 1, name: 'Slow Burner', artists: ['Someone'], bpm: 92, key_name: 'A Minor', genres: ['Deep House'] })]),
  ]);
  r = await lookupKeyBeatport(cfg, 'Someone', 'Slow Burner');
  check('92 kept as-is', r.bpm, '92');

  console.log('\nBeatport: fast drum & bass is left alone');
  reset([
    web([row({ id: 1, name: 'Inner City Life', artists: ['Goldie'], bpm: 155, key_name: 'G Major', genres: ['Drum & Bass'] })]),
  ]);
  r = await lookupKeyBeatport(cfg, 'Goldie', 'Inner City Life');
  check('155 kept as-is', r.bpm, '155');

  console.log('\nMatching: the near-misses Beatport really returns are rejected');
  check(
    'Pass Me The Rizla is not Pass Me The Dubplate',
    accepts('Deekline Featuring Tippa Irie', 'Pass Me The Dubplate', {
      name: 'Pass Me The Rizla (Original Mix)',
      artists: ['Tippa Irie', 'Deekline', 'General Levy'],
    }),
    false
  );
  check(
    'Original Nuttah 25 is not Original Nuttah',
    accepts('Shy FX & UK Apachi', 'Original Nuttah', {
      name: 'Original Nuttah 25 (Original Mix)',
      artists: ['Shy FX', 'UK Apache'],
    }),
    false
  );
  check(
    'a different remix is not the one asked for',
    accepts('Ed Solo And Deekline', 'Bad Boys (Benny Page Remix)', {
      name: 'Bad Boys (Benny Page ft. Kursiva Remix)',
      artists: ['Benny Page', 'Deekline', 'Ed Solo'],
    }),
    false
  );

  console.log('\nMatching: genuine matches still accepted');
  check(
    'exact match',
    accepts('Three Drives', 'Greece 2000', {
      name: 'Greece 2000 (Original Mix)',
      artists: ['Three Drives On A Vinyl'],
    }),
    true
  );
  check(
    'the remix actually asked for',
    accepts('Ed Solo And Deekline', 'Bad Boys (Benny Page Remix)', {
      name: 'Bad Boys (Benny Page Remix)',
      artists: ['Benny Page', 'Deekline', 'Ed Solo'],
    }),
    true
  );
  check(
    'artist spelling drift tolerated',
    accepts('Shy FX & UK Apachi', 'Original Nuttah', {
      name: 'Original Nuttah',
      artists: ['Shy FX', 'UK Apache'],
    }),
    true
  );
  check(
    'extra credited artist tolerated',
    accepts('Chase & Status', 'Blk & Blu', {
      name: 'Blk & Blu (Original Mix)',
      artists: ['Ed Thomas', 'Chase & Status'],
    }),
    true
  );
  check(
    'matching numbers still match',
    accepts('Various', 'Volume 4', { name: 'Volume 4', artists: ['Various'] }),
    true
  );
  check(
    'a plain cut is not answered with a remix',
    accepts('Shy FX', 'Bad Boys', {
      name: 'Bad Boys (Benny Page Remix)',
      artists: ['Shy FX'],
    }),
    false
  );

  console.log('\nBeatport: nothing convincing means nothing returned');
  reset([
    web([row({ id: 1, name: 'Completely Different', artists: ['Nobody'], bpm: 120, key_name: 'A Minor' })]),
  ]);
  r = await lookupKeyBeatport(cfg, 'Shy FX', 'Original Nuttah');
  check('no answer', [r.bpm, r.keyName], ['', '']);

  console.log('\nBeatport: answers are cached, and the API is skipped without a token');
  reset([
    web([row({ id: 1, name: 'Greece 2000', artists: ['Three Drives'], bpm: 132, key_name: 'Ab Minor', genres: ['Trance'] })]),
  ]);
  await lookupKeyBeatport(cfg, 'Three Drives', 'Greece 2000');
  check('API skipped', calls.some((u) => target(u).includes('api.beatport.com')), false);
  const before = calls.length;
  r = await lookupKeyBeatport(cfg, 'Three Drives', 'Greece 2000');
  check('no second request', calls.length, before);
  check('same answer', r.bpm, '132');

  console.log('\nChain: tunebat is the backup when Beatport has nothing');
  reset([
    web([]),
    (url) =>
      target(url).startsWith('https://api.tunebat.com')
        ? {
            body: {
              data: {
                items: [
                  { n: 'Original Nuttah', as: ['Shy FX', 'UK Apache'], k: 'A Minor', c: '8A', b: 169.8 },
                ],
              },
            },
          }
        : null,
  ]);
  r = await lookupKeyData(cfg, 'Shy FX & UK Apachi', 'Original Nuttah');
  check('fell back', r.source, 'tunebat');
  check('bpm rounded', r.bpm, '170');

  console.log('\nTunebat: a missing camelot is derived rather than lost');
  reset([
    web([]),
    (url) =>
      target(url).startsWith('https://api.tunebat.com')
        ? {
            body: {
              data: {
                items: [
                  // No `c` field at all, and the flat spelling of 3A.
                  { n: 'Original Nuttah', as: ['Shy FX', 'UK Apache'], k: 'B\u266d Minor', b: 170 },
                ],
              },
            },
          }
        : null,
  ]);
  r = await lookupKeyData(cfg, 'Shy FX & UK Apachi', 'Original Nuttah');
  check('camelot derived from the name', r.camelot, '3A');
  check('name normalised', r.keyName, 'Bb minor');
  check('key text complete', r.keyText, 'Bb minor (3A)');

  console.log('\nChain: Beatport wins when it has an answer');
  reset([
    web([row({ id: 1, name: 'Original Nuttah', artists: ['Shy FX', 'UK Apache'], bpm: 85, key_name: 'A Minor', genres: ['Jungle'] })]),
    (url) => (target(url).startsWith('https://api.tunebat.com') ? { body: { data: { items: [] } } } : null),
  ]);
  r = await lookupKeyData(cfg, 'Shy FX & UK Apachi', 'Original Nuttah');
  check('source', r.source, 'beatport');
  check('half-time corrected', r.bpm, '170');
  check('tunebat never asked', calls.some((u) => target(u).includes('tunebat')), false);

  console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nAll checks passed\n');
  process.exit(failures ? 1 : 0);
}

void main();

