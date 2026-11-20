const queuedJobs = Symbol('queuedJobs');
export const jobsCommittedEvent = 'fieldsync:jobs-committed';

// The signal is a latency hint; PostgreSQL still owns required work. Emit only
// after COMMIT, when the worker can see the new jobs, and never after rollback.
export function markJobsQueued(client) {
  client[queuedJobs] = true;
}

export async function transaction(pool, work, { readOnly = false } = {}) {
  const client = await pool.connect();
  let result, notify = false;
  delete client[queuedJobs];
  try {
    await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    result = await work(client);
    await client.query('COMMIT');
    notify = !!client[queuedJobs];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    delete client[queuedJobs];
    client.release();
  }
  if (notify) {
    try { pool.emit(jobsCommittedEvent); } catch { /* Periodic recovery retains SQL intent. */ }
  }
  return result;
}
