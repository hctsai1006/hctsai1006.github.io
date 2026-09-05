import { classifySupport } from '../tools/verify-release-truth.mts';
for (const now of ['2026-11-09T11:59:59.999Z','2026-11-09T12:00:00.001Z','2026-11-09T23:59:59.999Z','2026-11-10T00:00:00.000Z','2026-11-10T00:00:00.001Z']) {
  const c = classifySupport('2026-11-10', Date.parse(now), 180);
  console.log(now, '| remaining', String(c?.remainingMs).padStart(9), '| expired', String(c?.expired).padEnd(5), '| approaching', c?.approaching);
}
console.log('unparseable date ->', classifySupport('not-a-date', Date.now(), 180));
