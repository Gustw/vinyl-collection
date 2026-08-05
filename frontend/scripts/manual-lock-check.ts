/**
 * Checks that a value corrected by hand survives a Beatport/tunebat pass.
 *
 * The protection is worth testing rather than eyeballing, because the failure
 * is silent and destructive: the pass overwrites the edit in memory and then
 * commits that to tracks.txt, so the correction is lost from the file even
 * though the local override would still mask it until the cache is cleared.
 *
 * Since the lock is written into tracks.txt itself (`Manual: key,bpm`), the
 * round trip through the file is checked here too — that is what carries the
 * protection to a second browser, where there is no local override to fall
 * back on and a re-fetch would otherwise revert the edit for everyone.
 *
 * Run with: npm run check:manual
 */
import { CollectionService, parseTracksTxt } from '../src/app/collection.service';
import { UpdaterService } from '../src/app/updater.service';
import { renderTracksTxt } from '../src/app/tracks-format';
import { Rec, Track } from '../src/app/models';

// --- stubs ---------------------------------------------------------------

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};

/** Beatport answers everything with a confident, different value. */
const BEATPORT = { name: 'Test Track', bpm: 128, key_name: 'C Major' };
let lookups: string[] = [];

(globalThis as any).fetch = async (url: string) => {
  const i = url.indexOf('?url=');
  const t = i >= 0 ? decodeURIComponent(url.slice(i + 5)) : url;
  lookups.push(t);
  if (t.startsWith('https://www.beatport.com/search/tracks')) {
    const q = new URL(t).searchParams.get('q') || '';
    return {
      status: 200,
      headers: { get: () => null },
      text: async () =>
        `<script id="__NEXT_DATA__" type="application/json">` +
        JSON.stringify({
          props: {
            pageProps: {
              dehydratedState: {
                queries: [
                  {
                    state: {
                      data: {
                        data: [
                          {
                            track_id: 1,
                            // Echo the query so the matcher always accepts.
                            track_name: q.replace(/^.*?\s/, ''),
                            mix_name: 'Original Mix',
                            artists: [{ artist_id: 1, artist_name: q.split(' ')[0] }],
                            bpm: BEATPORT.bpm,
                            key_name: BEATPORT.key_name,
                            genre: [{ genre_id: 5, genre_name: 'House' }],
                          },
                        ],
                      },
                    },
                  },
                ],
              },
            },
          },
        }) +
        `</script>`,
      json: async () => ({}),
    } as any;
  }
  throw new Error('blocked ' + t);
};

// The services only need a ConfigService-shaped object. The real one runs an
// effect() in its constructor, which needs a full Angular runtime, so a stub
// with the same `config` signal is provided instead.
import { Injector, signal } from '@angular/core';
import { ConfigService, defaultConfig } from '../src/app/config.service';

const configStub = {
  config: signal({ ...defaultConfig(), corsProxy: 'https://proxy.test/?url=' }),
  update() {},
} as unknown as ConfigService;

const injector = Injector.create({
  providers: [
    { provide: ConfigService, useValue: configStub },
    { provide: CollectionService, useClass: CollectionService, deps: [] },
    { provide: UpdaterService, useClass: UpdaterService, deps: [] },
  ],
});

// --- helpers -------------------------------------------------------------

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

function track(o: Partial<Track>): Track {
  return {
    id: 0, title: 'Test Track', artist: 'Tester', position: '', duration: '',
    keyName: '', camelot: '', keyText: '', bpm: '', manualKey: false,
    manualBpm: false, recordTitle: 'Rec', recordArtist: 'Tester', genres: [],
    styles: [], year: 0, labels: [], artwork: '', releaseId: '123', ...o,
  };
}

function recordsWith(tracks: Track[]): Rec[] {
  return [{ releaseId: '123', title: 'Rec', artist: 'Tester', genres: [], styles: [], year: 0, labels: [], artwork: '', tracks }];
}

async function run(col: CollectionService, up: UpdaterService, tracks: Track[]) {
  col.setRecords(recordsWith(tracks));
  lookups = [];
  await up.refetchAll({ source: 'beatport', restart: true });
}

// --- the checks ----------------------------------------------------------

async function main() {
  const col = injector.get(CollectionService);
  const up = injector.get(UpdaterService);
  // No GitHub is configured, so nothing is committed; we inspect memory only.

  console.log('\nA hand-corrected key and BPM are both left alone');
  {
    store.clear();
    (col as any).overrides = {};
    const t = track({ title: 'Locked Both', keyName: 'A minor', camelot: '8A', keyText: 'A minor (8A)', bpm: '175' });
    col.setRecords(recordsWith([t]));
    col.setTrackKeyBpm(t, 'A minor', '8A', '175');
    await run(col, up, [t]);
    check('key kept', t.keyText, 'A minor (8A)');
    check('bpm kept', t.bpm, '175');
    check('nothing reported as corrected', up.corrected(), 0);
    check('counted as manual', up.manuallyLocked(), 1);
    check('no request was made', lookups.length, 0);
  }

  console.log('\nA hand-corrected BPM is kept while the key is still filled in');
  {
    store.clear();
    (col as any).overrides = {};
    const t = track({ title: 'Locked Bpm', bpm: '175' });
    col.setRecords(recordsWith([t]));
    col.setTrackKeyBpm(t, '', '', '175'); // BPM only
    await run(col, up, [t]);
    check('bpm kept', t.bpm, '175');
    check('key was filled from beatport', t.keyName, 'C major');
    check('a request was made', lookups.length > 0, true);
  }

  console.log('\nA hand-corrected key is kept while the BPM is still filled in');
  {
    store.clear();
    (col as any).overrides = {};
    const t = track({ title: 'Locked Key', keyName: 'A minor', camelot: '8A', keyText: 'A minor (8A)' });
    col.setRecords(recordsWith([t]));
    col.setTrackKeyBpm(t, 'A minor', '8A', '');
    await run(col, up, [t]);
    check('key kept', t.keyText, 'A minor (8A)');
    check('bpm was filled from beatport', t.bpm, '128');
  }

  console.log('\nAn untouched track is still corrected as before');
  {
    store.clear();
    (col as any).overrides = {};
    const t = track({ title: 'Free Track', keyName: 'G major', camelot: '9B', keyText: 'G major (9B)', bpm: '100' });
    await run(col, up, [t]);
    check('key updated', t.keyText, 'C major (8B)');
    check('bpm updated', t.bpm, '128');
    check('counted as corrected', up.corrected(), 1);
    check('not counted as manual', up.manuallyLocked(), 0);
  }

  console.log('\nUnlocking hands the track back to the lookups');
  {
    store.clear();
    (col as any).overrides = {};
    const t = track({ title: 'Unlock Me', keyName: 'A minor', camelot: '8A', keyText: 'A minor (8A)', bpm: '175' });
    col.setRecords(recordsWith([t]));
    col.setTrackKeyBpm(t, 'A minor', '8A', '175');
    check('locked before', col.isManuallySet(t), true);
    col.clearManual(t);
    check('unlocked after', col.isManuallySet(t), false);
    await run(col, up, [t]);
    check('now updated', t.bpm, '128');
  }

  console.log('\nThe lock survives a reload from this browser (localStorage)');
  {
    store.clear();
    (col as any).overrides = {};
    const t = track({ title: 'Persist Me', keyName: 'A minor', camelot: '8A', keyText: 'A minor (8A)', bpm: '175' });
    col.setRecords(recordsWith([t]));
    col.setTrackKeyBpm(t, 'A minor', '8A', '175');

    // A fresh parse, as after a page load: the stored override is re-applied on
    // top and must restore both flags.
    const reloaded = parseTracksTxt(renderTracksTxt(recordsWith([track({ title: 'Persist Me' })])));
    (col as any).overrides = JSON.parse(store.get('overrides.tracks') || '{}');
    (col as any).applyOverrides(reloaded);
    check('key restored', reloaded[0].tracks[0].keyText, 'A minor (8A)');
    check('still locked', col.manualLock(reloaded[0].tracks[0]), { key: true, bpm: true });
  }

  console.log('\nThe lock travels in tracks.txt, so another device sees it too');
  {
    store.clear();
    (col as any).overrides = {};
    const t = track({ title: 'Shared Lock' });
    col.setRecords(recordsWith([t]));
    col.setTrackKeyBpm(t, 'A minor', '8A', '175');

    const text = renderTracksTxt(col.records());
    check('written into the metadata block', /\| Manual: key,bpm]/.test(text), true);

    // The other device: same file, empty localStorage.
    store.clear();
    const fresh = parseTracksTxt(text);
    (col as any).overrides = {};
    const other = fresh[0].tracks[0];
    check('read back with no local override', col.manualLock(other), { key: true, bpm: true });

    // …and a re-fetch run there must still leave the correction alone.
    col.setRecords(fresh);
    await run(col, up, fresh[0].tracks);
    check('key kept on the other device', other.keyText, 'A minor (8A)');
    check('bpm kept on the other device', other.bpm, '175');
    check('no request was made', lookups.length, 0);
  }

  console.log('\nOnly the hand-set field is flagged, and unlocking clears the flag');
  {
    store.clear();
    (col as any).overrides = {};
    const t = track({ title: 'Bpm Only', keyName: 'G major', camelot: '9B', keyText: 'G major (9B)' });
    col.setRecords(recordsWith([t]));
    col.setTrackKeyBpm(t, '', '', '175'); // BPM only

    const text = renderTracksTxt(col.records());
    check('only bpm is flagged', /\| Manual: bpm]/.test(text), true);

    const back = parseTracksTxt(text)[0].tracks[0];
    check('round-trips', col.manualLock(back), { key: false, bpm: true });

    col.clearManual(t);
    check('flag gone after unlock', /Manual:/.test(renderTracksTxt(col.records())), false);
  }

  console.log('\nA file from a newer version is still readable');
  {
    // An unknown field must not make the whole block unrecognisable — that
    // would silently drop the key and BPM of every track in the file.
    const text =
      '=== Rec -- Tester ===\n  ID: 123\n' +
      '   1. Future Track - Tester [Pos: A1 | Key: A minor (8A) | BPM: 175 | Mood: dark | Manual: key]\n';
    const t = parseTracksTxt(text)[0].tracks[0];
    check('key survived', t.keyText, 'A minor (8A)');
    check('bpm survived', t.bpm, '175');
    check('known flag still read', col.manualLock(t), { key: true, bpm: false });
  }

  console.log('\nA title that merely ends in brackets is left alone');
  {
    const text = '=== Rec -- Tester ===\n   1. Bad Boys [VIP] - Tester\n';
    const t = parseTracksTxt(text)[0].tracks[0];
    check('title intact', t.title, 'Bad Boys [VIP]');
  }

  console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nAll checks passed\n');
  process.exit(failures ? 1 : 0);
}

void main();



