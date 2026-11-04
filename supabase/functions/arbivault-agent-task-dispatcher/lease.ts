// Pure task-lease / authorization rules for arbivault-agent-task-dispatcher (no I/O, unit-tested in lease_test.ts).
export const LEASE_MS = 15 * 60_000

export type AgentTask = {
  id: string
  owner_id: string | null
  status: 'pending' | 'claimed' | 'running' | 'completed' | 'failed' | 'retrying'
  assigned_agent: string | null
  lease_expires_at: string | null
  retry_count: number
  max_retries: number
}

export const leaseExpired = (task: AgentTask, now: Date) =>
  (task.status === 'claimed' || task.status === 'running') &&
  !!task.lease_expires_at && new Date(task.lease_expires_at).getTime() <= now.getTime()

// Only the task owner may act on a task; shared (owner_id null) rows are service-role only.
export const ownsTask = (task: AgentTask, userId: string) => !!task.owner_id && task.owner_id === userId

export function claimDecision(task: AgentTask, userId: string, now: Date):
  { ok: true; reclaimed: boolean } | { ok: false; error: string } {
  if (!ownsTask(task, userId)) return { ok: false, error: 'task_not_found' }
  if (task.status === 'pending' || task.status === 'retrying') return { ok: true, reclaimed: false }
  if (leaseExpired(task, now)) {
    if (task.retry_count + 1 > task.max_retries) return { ok: false, error: 'task_retries_exhausted' }
    return { ok: true, reclaimed: true }
  }
  return { ok: false, error: 'task_not_claimable' }
}

export function completeDecision(task: AgentTask, userId: string, agentName: string, now: Date):
  { ok: true } | { ok: false; error: string } {
  if (!ownsTask(task, userId)) return { ok: false, error: 'task_not_found' }
  if (task.status !== 'claimed' && task.status !== 'running') return { ok: false, error: 'task_not_running' }
  if (task.assigned_agent !== agentName) return { ok: false, error: 'task_claimed_by_other_agent' }
  if (leaseExpired(task, now)) return { ok: false, error: 'task_lease_expired' }
  return { ok: true }
}

// Failure (reported or lease expiry): count the attempt, requeue until max_retries, then mark failed.
export function failureUpdate(task: AgentTask) {
  const retry_count = task.retry_count + 1
  const exhausted = retry_count >= task.max_retries
  return {
    status: exhausted ? 'failed' as const : 'retrying' as const,
    retry_count,
    assigned_agent: null,
    claimed_at: null,
    lease_expires_at: null,
  }
}
