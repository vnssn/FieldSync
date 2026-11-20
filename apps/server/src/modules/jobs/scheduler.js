// One timer, no overlapping passes. Wake signals accelerate committed work;
// the idle deadline still recovers jobs when a signal or Redis entry is lost.
export function createReconciliationScheduler({ run, intervalMs, idleIntervalMs,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer, running, stopped = false, wakeRequested = false;

  function schedule(delay) {
    clearTimer(timer);
    if (!stopped) timer = setTimer(() => { void reconcile(); }, delay);
  }

  async function reconcile() {
    if (stopped) return;
    // Explicit callers wait for a fresh pass, not a possibly stale active pass.
    if (running) { await running; return reconcile(); }
    clearTimer(timer);
    let delay = intervalMs;
    running = (async () => {
      try {
        const next = await run();
        delay = next == null ? idleIntervalMs : Math.min(idleIntervalMs, Math.max(intervalMs, next));
      } catch { /* Retry promptly after outages; durable work remains in SQL. */ }
    })();
    try { await running; }
    finally {
      running = undefined;
      schedule(wakeRequested ? 0 : delay);
      wakeRequested = false;
    }
  }

  function wake() {
    if (stopped) return;
    if (running) wakeRequested = true;
    else schedule(0);
  }

  return { reconcile, wake,
    async close() { stopped = true; clearTimer(timer); await running; },
  };
}
