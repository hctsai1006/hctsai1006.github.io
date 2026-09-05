import { MemoryStorage, NullJournal } from '../src/storage/index.ts';
const j = new NullJournal();
const st = new MemoryStorage({ clock: () => 0, journal: j, capacity: 256 * 1024 });
await st.reset();
const N = 16, SIZE = 64 * 1024;
for (let i = 0; i < N; i += 1) await st.writeBytes('/same', new Uint8Array(SIZE).fill(i));
await st.remove('/same', {});
await st.reset();

const anyJ = j as unknown as { written: { steps?: { data?: Uint8Array }[] }[]; committed: unknown[] };
const seen = new Set<ArrayBufferLike>();
let bytes = 0;
for (const plan of anyJ.written ?? []) for (const s of plan.steps ?? []) {
  if (s.data && !seen.has(s.data.buffer)) { seen.add(s.data.buffer); bytes += s.data.byteLength; }
}
console.log('after', N, 'overwrites of one file, then remove(), then reset():');
console.log('  plans retained in journal.written  :', (anyJ.written ?? []).length);
console.log('  plans retained in journal.committed:', (anyJ.committed ?? []).length);
console.log('  distinct payload buffers still referenced:', seen.size);
console.log('  bytes still referenced            :', bytes.toLocaleString());
console.log('  live file exists                  :', (await st.stat('/same')).ok);
const q = await st.quota(); console.log('  quota.used reports                :', q.ok ? q.value.used : 'n/a');
