/**
 * Checks that a change which fails to reach GitHub is not lost.
 *
 * This is the failure mode that matters most in the whole app: the edit appears
 * to work, the collection on screen is correct, and the only copy of the truth
 * is in one browser's localStorage. Everything else — every other device, and
 * this one after a cache clear — still has the old value, and the next
 * automated pass will happily commit that old value back over the top.
 *
 * So the pending-change marker, its survival across a reload, and the retry
 * that eventually lands it are all checked here rather than trusted.
 *
 * Run with: npm run check:sync
 */
import { Injector, signal } from '@angular/core';
import { CollectionService, parseTracksTxt } from '../src/app/collection.service';
import { ConfigService, defaultConfig } from '../src/app/config.service';

// --- stubs ---------------------------------------------------------------

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};

/** The file as GitHub currently has it, and a log of what we tried to write. */
let remote = '';
let writes: string[] = [];
/** When true every GitHub call fails, standing in for an outage. */
let offline = false;
/** When true even the raw CDN read fails, so the bundled asset is used. */
let rawDown = false;
/** The build-time snapshot shipped in the app, deliberately out of date. */
let asset = '';

const FILE = `=== Rec -- Tester ===
Id: 123
   1. Test Track - Tester [Key: A minor (8A) | BPM: 175]
`;

(globalThis as any).fetch = async (url: string, init?: any) => {
  const ok = (body: unknown) => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => String(body),
  });
  if (url.startsWith('assets/')) return ok(asset) as any;
  if (url.startsWith('https://raw.githubusercontent.com/')) {
    if (rawDown) throw new Error('cdn down');
    // The raw URL is a CDN and stays readable even when the API write fails.
    return ok(remote) as any;
  }
  if (offline) throw new Error('network down');
  if (url.startsWith('https://api.github.com/')) {
    if (init?.method === 'PUT') {
      const body = JSON.parse(init.body);
      const text = Buffer.from(body.content, 'base64').toString('utf8');
      writes.push(text);
      remote = text;
      return ok({ content: { sha: 'sha' + writes.length } }) as any;
    }
    return ok({
      content: Buffer.from(remote, 'utf8').toString('base64'),
      sha: 'sha' + writes.length,
    }) as any;
  }
  throw new Error('blocked ' + url);
};

function makeService(): CollectionService {
  const configStub = {
    config: signal({
      ...defaultConfig(),
      githubOwner: 'o',
      githubRepo: 'r',
      githubBranch: 'main',
      tracksPath: 'tracks.txt',
      githubToken: 't',
    }),
    update() {},
  } as unknown as ConfigService;
  const injector = Injector.create({
    providers: [
      { provide: ConfigService, useValue: configStub },
      { provide: CollectionService, useClass: CollectionService, deps: [] },
    ],
  });
  return injector.get(CollectionService);
}

/** Builds a service and waits for its constructor's reload() to settle. */
async function loadedService(): Promise<CollectionService> {
  const col = makeService();
  for (let i = 0; i < 50 && !col.loaded(); i++) await new Promise((r) => setTimeout(r, 0));
  // Let the drift check and the retry it may start run to completion.
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  return col;
}

/** Writes a localStorage override the way an earlier session would have. */
function seedOverride(o: Record<string, unknown>) {
  store.set(
    'overrides.tracks',
    JSON.stringify({ ['123\u0000test track\u0000tester']: o })
  );
}

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

function reset() {
  store.clear();
  remote = FILE;
  asset = FILE;
  writes = [];
  offline = false;
  rawDown = false;
}

/**
 * Node ships a read-only `navigator`, so it is redefined rather than assigned.
 * Worth doing properly: "don't try while the browser knows it is offline" is
 * the guard that stops the retry loop hammering a dead connection.
 */
function setOnline(on: boolean) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: on },
    configurable: true,
  });
}

// --- the checks ----------------------------------------------------------

async function main() {
  console.log('\nA successful save leaves nothing pending');
  {
    reset();
    const col = await loadedService();
    const t = col.tracks()[0];
    col.setTrackKeyBpm(t, 'C major', '8B', '128');
    await col.commitToGithub('edit');
    check('written to github', writes.length, 1);
    check('file has the new bpm', /BPM: 128/.test(remote), true);
    check('nothing pending', col.pending(), null);
  }

  console.log('\nA failed save is recorded, durably');
  {
    reset();
    const col = await loadedService();
    const t = col.tracks()[0];
    col.setTrackKeyBpm(t, 'C major', '8B', '128');
    offline = true;
    await col.commitToGithub('edit').catch(() => {});
    check('nothing reached github', writes.length, 0);
    check('marked pending', !!col.pending(), true);
    check('the marker is in localStorage', !!store.get('pending.sync'), true);
  }

  console.log('\nAnd a later session picks it up and pushes it');
  {
    // Same localStorage, new service: this is a page reload after the failure.
    offline = false;
    const col = await loadedService();
    check('pushed on load', writes.length, 1);
    check('nothing pending any more', col.pending(), null);
    check('the edit is in the file', /BPM: 128/.test(remote), true);
    check('and so is the manual flag', /Manual: key,bpm/.test(remote), true);
  }

  console.log('\nThe retry merges against the current file, not a stale sha');
  {
    reset();
    const col = await loadedService();
    const t = col.tracks()[0];
    col.setTrackKeyBpm(t, '', '', '86');
    offline = true;
    await col.commitToGithub('edit').catch(() => {});
    // Somebody else commits in the meantime, so any sha we held is now stale.
    remote = FILE.replace('BPM: 175', 'BPM: 174');
    offline = false;
    check('retry succeeds', await col.retrySync(), true);
    check('our value won', /BPM: 86/.test(remote), true);
  }

  console.log('\nA retry never overwrites the collection with an empty file');
  {
    reset();
    const col = await loadedService();
    col.markPending('edit', 'boom');
    col.setRecords([]);
    check('refused', await col.retrySync(), false);
    check('nothing written', writes.length, 0);
    check('still pending', !!col.pending(), true);
  }

  console.log('\nA retry does nothing while the browser is offline');
  {
    reset();
    const col = await loadedService();
    col.markPending('edit', 'boom');
    setOnline(false);
    check('refused', await col.retrySync(), false);
    setOnline(true);
    check('accepted once back online', await col.retrySync(), true);
  }

  console.log('\nA deliberately cleared value is not resurrected by a reload');
  {
    // The regression this guards: clearing a bogus BPM used to delete the
    // override outright, so the next load read the old value straight back out
    // of tracks.txt and the correction silently undid itself.
    reset();
    const col = await loadedService();
    const t = col.tracks()[0];
    col.setTrackKeyBpm(t, 'A minor', '8A', ''); // BPM emptied on purpose
    check('cleared in memory', t.bpm, '');
    check('and locked, so nothing refills it', t.manualBpm, true);

    offline = true;
    await col.commitToGithub('edit').catch(() => {});
    offline = false;
    // The file on GitHub still says 175 — the commit never landed.
    check('remote still has the old value', /BPM: 175/.test(remote), true);

    const col2 = await loadedService();
    check('still cleared after a reload', col2.tracks()[0].bpm, '');
    check('and pushed on that load', /BPM: 175/.test(remote), false);
  }

  console.log('\nThe file round-trips an emptied field without the flag rotting');
  {
    const recs = parseTracksTxt(
      '=== Rec -- Tester ===\nId: 123\n   1. T - Tester [Key: A minor (8A) | Manual: key,bpm]\n'
    );
    check('a flag over a missing value is dropped', recs[0].tracks[0].manualBpm, false);
    check('a flag over a present value is kept', recs[0].tracks[0].manualKey, true);
  }

  console.log('\nWork already stranded before any marker existed is found and pushed');
  {
    // The state an older build would leave behind: an edit in localStorage,
    // a tracks.txt that never received it, and no pending marker at all.
    reset();
    seedOverride({ keyName: 'C major', camelot: '8B', keyText: 'C major (8B)', bpm: '128' });
    check('no marker exists to go on', store.get('pending.sync') ?? null, null);
    const col = await loadedService();
    check('drift was detected and pushed', writes.length, 1);
    check('the file now has the edit', /BPM: 128/.test(remote), true);
    check('nothing left pending', col.pending(), null);
  }

  console.log('\nAnd so is a re-fetch run whose results never reached GitHub');
  {
    // The Beatport/tunebat cache is the only copy of a filled-in key here.
    reset();
    remote = '=== Rec -- Tester ===\nId: 123\n   1. Test Track - Tester\n';
    store.set(
      'tunebat.v2.Tester Test Track',
      JSON.stringify({ keyName: 'C major', camelot: '8B', keyText: 'C major (8B)', bpm: '128' })
    );
    const col = await loadedService();
    check('the cached values were pushed', /BPM: 128/.test(remote), true);
    check('nothing left pending', col.pending(), null);
  }

  console.log('\nA file that already matches clears a stale marker');
  {
    reset();
    // A marker left over from a failure that was since resolved elsewhere.
    store.set(
      'pending.sync',
      JSON.stringify({ message: 'old', since: 1, attempts: 3, lastError: 'boom' })
    );
    const col = await loadedService();
    check('marker cleared', col.pending(), null);
    check('and nothing was committed', writes.length, 0);
  }

  console.log('\nThe bundled asset is never mistaken for the committed file');
  {
    // GitHub is unreachable, so the app falls back to its build-time snapshot.
    // That snapshot is older than the repo, and pushing it would destroy work.
    reset();
    remote = FILE.replace('BPM: 175', 'BPM: 174');
    asset = FILE;
    rawDown = true;
    const col = await loadedService();
    check('no drift reported', col.pending(), null);
    check('nothing written', writes.length, 0);
    check('the repo still has its own value', /BPM: 174/.test(remote), true);
  }

  console.log(failures ? `\n${failures} FAILED\n` : '\nAll checks passed\n');
  process.exit(failures ? 1 : 0);
}

void main();









