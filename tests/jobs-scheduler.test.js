import test from 'node:test';
import assert from 'node:assert/strict';
import { createReconciliationScheduler } from '../apps/server/src/modules/jobs/scheduler.js';

function clock() {
  let time = 0, id = 0;
  const timers = new Map();
  return {
    setTimer(callback, delay) { timers.set(++id, { callback, at:time+delay }); return id; },
    clearTimer(handle) { timers.delete(handle); },
    get count() { return timers.size; },
    async advance(ms) {
      const end = time+ms;
      for (;;) {
        const entry = [...timers].filter(([,t]) => t.at<=end).sort((a,b) => a[1].at-b[1].at)[0];
        if (!entry) break;
        time = entry[1].at; timers.delete(entry[0]); entry[1].callback();
        // Allow reconciliation and its finally block to schedule the next pass.
        for (let i=0;i<8;i++) await Promise.resolve();
      }
      time = end;
    },
  };
}

test('idle recovery permits a twenty-nine-minute query-free window and still runs at thirty minutes', async () => {
  const timer = clock(); let passes = 0;
  const scheduler = createReconciliationScheduler({ ...timer, intervalMs:5000, idleIntervalMs:1800000,
    run:async () => { passes++; return null; } });
  await scheduler.reconcile();
  await timer.advance(29*60000);
  assert.equal(passes,1);
  await timer.advance(60000);
  assert.equal(passes,2);
  await scheduler.close();
  assert.equal(timer.count,0);
});

test('known future work wakes at its deadline without intervening fast polling', async () => {
  const timer = clock(); let passes = 0;
  const scheduler = createReconciliationScheduler({ ...timer, intervalMs:5000, idleIntervalMs:1800000,
    run:async () => { passes++; return passes===1 ? 10*60000 : null; } });
  await scheduler.reconcile();
  await timer.advance(10*60000-1); assert.equal(passes,1);
  await timer.advance(1); assert.equal(passes,2);
  await scheduler.close();
});

test('wake hints coalesce and a hint during an active pass schedules a non-overlapping fresh pass', async () => {
  const timer = clock(); let passes = 0, release;
  const gate = new Promise((done) => { release=done; });
  const scheduler = createReconciliationScheduler({ ...timer, intervalMs:5000, idleIntervalMs:1800000,
    run:async () => { if (++passes===1) await gate; return null; } });
  const running=scheduler.reconcile();
  scheduler.wake(); scheduler.wake(); assert.equal(passes,1);
  release(); await running;
  await timer.advance(0); assert.equal(passes,2);
  scheduler.wake(); scheduler.wake(); await timer.advance(0); assert.equal(passes,3);
  await scheduler.close();
});

test('overdue jobs and reconciliation failures retain fast retry rather than idle sleep', async () => {
  const timer=clock(); let passes=0;
  const scheduler=createReconciliationScheduler({ ...timer, intervalMs:5000, idleIntervalMs:1800000,
    run:async () => { passes++; if(passes===2) throw new Error('outage'); return passes===1 ? -1 : null; } });
  await scheduler.reconcile();
  await timer.advance(4999); assert.equal(passes,1);
  await timer.advance(1); assert.equal(passes,2);
  await timer.advance(5000); assert.equal(passes,3);
  await scheduler.close();
});

test('shutdown waits for an active pass and suppresses all later wakes', async () => {
  const timer=clock(); let release, passes=0;
  const gate=new Promise((done) => { release=done; });
  const scheduler=createReconciliationScheduler({ ...timer, intervalMs:5000, idleIntervalMs:1800000,
    run:async () => { passes++; await gate; return null; } });
  const running=scheduler.reconcile(), closing=scheduler.close();
  scheduler.wake(); release(); await Promise.all([running,closing]);
  await timer.advance(3600000); scheduler.wake();
  assert.equal(passes,1); assert.equal(timer.count,0);
});
