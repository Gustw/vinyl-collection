/**
 * Checks that a value corrected by hand survives a Beatport/tunebat pass.
 *
 * The protection is worth testing rather than eyeballing, because the failure
 * is silent and destructive: the pass overwrites the edit in memory and then
 * commits that to tracks.txt, so the correction is lost from the file even
 * though the local override would still mask it until the cache is cleared.
 *
 * Run with: npm run check:manual
 */
import { CollectionService } from '../src/app/collection.service';
import { UpdaterService } from '../src/app/updater.service';
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
    keyName: '', camelot: '', keyText: '', bpm: '', recordTitle: 'Rec',
    recordArtist: 'Tester', genres: [], styles: [], year: 0, labels: [],
    artwork: '', releaseId: '123', ...o,
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

  console.log('\nThe lock survives a reload (it lives in localStorage)');
  {
    store.clear();
    (col as any).overrides = {};
    const t = track({ title: 'Persist Me', keyName: 'A minor', camelot: '8A', keyText: 'A minor (8A)', bpm: '175' });
    col.setRecords(recordsWith([t]));
    col.setTrackKeyBpm(t, 'A minor', '8A', '175');
    // A fresh service reads the same storage, as it would after a page load.
    const fresh = injector.get(CollectionService, null, { optional: true }) as CollectionService;
    const reloaded = Object.create(Object.getPrototypeOf(fresh)) as CollectionService;
    (reloaded as any).overrides = JSON.parse(store.get('overrides.tracks') || '{}');
    check('still locked', reloaded.manualLock(t), { key: true, bpm: true });
  }

  console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nAll checks passed\n');
  process.exit(failures ? 1 : 0);
}

void main();



