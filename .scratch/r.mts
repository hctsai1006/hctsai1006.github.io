import { MemoryStorage, NullJournal, isOk } from '../src/storage/index.ts';

const st = new MemoryStorage({ clock: () => 0 });
await st.reset();

// R1 — does a write take ownership of the caller's bytes?
const input = new Uint8Array([65, 66]);
const w = await st.writeBytes('/file', input);
console.log('write ok:', isOk(w));
input[0] = 90;                                  // caller reuses its buffer
const read = await st.readBytes('/file');
const got = isOk(read) ? [...read.value] : 'ERR';
console.log('R1 after mutating the caller buffer, file reads:', JSON.stringify(got), got.toString() === '65,66' ? '<- OK' : '<- CHANGED, defect');

// R1b — append to a file that does not exist yet
const inp2 = new Uint8Array([1, 2]);
await st.appendBytes('/new', inp2);
inp2[0] = 99;
const r2 = await st.readBytes('/new');
console.log('R1b append-to-new after mutation:', isOk(r2) ? JSON.stringify([...r2.value]) : 'ERR');

// R2 — does the default journal retain payloads forever?
const j = new NullJournal();
const st2 = new MemoryStorage({ clock: () => 0, journal: j });
await st2.reset();
const big = new Uint8Array(64 * 1024).fill(7);
for (let i = 0; i < 16; i += 1) await st2.writeBytes('/same', big.map((x) => (x + i) % 251));
await st2.remove('/same', {});
await st2.reset();
const anyJ = j as unknown as Record<string, unknown[]>;
const keys = Object.getOwnPropertyNames(j).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(j)));
console.log('R2 NullJournal own/proto members:', keys.filter((k) => k !== 'constructor').join(', '));
console.log('R2 pending():', typeof (j as { pending?: () => unknown[] }).pending === 'function' ? (j as { pending: () => unknown[] }).pending().length : 'n/a');
