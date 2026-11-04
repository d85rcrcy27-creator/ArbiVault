import { assertEquals } from 'jsr:@std/assert@1'
import { claimDecision, completeDecision, failureUpdate, type AgentTask } from './lease.ts'

const now = new Date('2026-11-04T00:00:00Z')
const base: AgentTask = { id: 't1', owner_id: 'u1', status: 'pending', assigned_agent: null, lease_expires_at: null, retry_count: 0, max_retries: 3 }

Deno.test('claim: owner can claim pending task', () => assertEquals(claimDecision(base, 'u1', now), { ok: true, reclaimed: false }))
Deno.test('claim: other user cannot see or claim task', () => assertEquals(claimDecision(base, 'u2', now).ok, false))
Deno.test('claim: shared owner_id null rows are not claimable by users', () =>
  assertEquals(claimDecision({ ...base, owner_id: null }, 'u1', now), { ok: false, error: 'task_not_found' }))
Deno.test('claim: active lease blocks a second claim', () =>
  assertEquals(claimDecision({ ...base, status: 'running', assigned_agent: 'a', lease_expires_at: '2026-11-04T00:10:00Z' }, 'u1', now), { ok: false, error: 'task_not_claimable' }))
Deno.test('claim: expired lease is reclaimable', () =>
  assertEquals(claimDecision({ ...base, status: 'running', assigned_agent: 'a', lease_expires_at: '2026-11-03T23:59:00Z' }, 'u1', now), { ok: true, reclaimed: true }))
Deno.test('claim: expired lease with retries exhausted is not reclaimable', () =>
  assertEquals(claimDecision({ ...base, status: 'running', lease_expires_at: '2026-11-03T23:00:00Z', retry_count: 3 }, 'u1', now).ok, false))
const running: AgentTask = { ...base, status: 'running', assigned_agent: 'agent-a', lease_expires_at: '2026-11-04T00:10:00Z' }
Deno.test('complete: same agent + owner + live lease', () => assertEquals(completeDecision(running, 'u1', 'agent-a', now), { ok: true }))
Deno.test('complete: different agent rejected', () => assertEquals(completeDecision(running, 'u1', 'agent-b', now), { ok: false, error: 'task_claimed_by_other_agent' }))
Deno.test('complete: non-owner rejected', () => assertEquals(completeDecision(running, 'u2', 'agent-a', now).ok, false))
Deno.test('complete: pending task rejected', () => assertEquals(completeDecision(base, 'u1', 'agent-a', now), { ok: false, error: 'task_not_running' }))
Deno.test('complete: expired lease rejected', () =>
  assertEquals(completeDecision({ ...running, lease_expires_at: '2026-11-03T23:00:00Z' }, 'u1', 'agent-a', now), { ok: false, error: 'task_lease_expired' }))
Deno.test('failure: requeues and increments retry_count', () => {
  const u = failureUpdate({ ...running, retry_count: 0 })
  assertEquals([u.status, u.retry_count, u.assigned_agent, u.lease_expires_at], ['retrying', 1, null, null])
})
Deno.test('failure: marks failed at max_retries', () => assertEquals(failureUpdate({ ...running, retry_count: 2 }).status, 'failed'))
