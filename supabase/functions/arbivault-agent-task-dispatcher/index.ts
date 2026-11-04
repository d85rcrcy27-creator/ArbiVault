import { createClient } from 'npm:@supabase/supabase-js@2.117.2'
import { type AgentTask, claimDecision, completeDecision, failureUpdate, LEASE_MS } from './lease.ts'

const url = Deno.env.get('SUPABASE_URL')!
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { ...cors, 'cache-control': 'no-store' } })

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  try {
    const authorization = req.headers.get('Authorization') || ''
    if (!authorization.toLowerCase().startsWith('bearer ')) {
      return json({ error: 'authentication_required' }, 401)
    }
    const caller = createClient(url, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: { user }, error: authError } = await caller.auth.getUser()
    if (authError || !user) return json({ error: 'authentication_required' }, 401)

    const body = await req.json().catch(() => ({}))
    const action = String(body.action || 'list')
    const now = new Date()

    // The service-role client bypasses RLS, so every task read below is scoped to the caller.
    const loadOwnTask = async (taskId: string) => {
      if (!taskId) return null
      const { data } = await admin.from('agent_tasks').select('*').eq('id', taskId).eq('owner_id', user.id).maybeSingle()
      return (data as AgentTask | null) ?? null
    }
    // Agent identity must be an active agent registered by this user (no arbitrary names).
    const registeredAgent = async (name: string) => {
      if (!name) return false
      const { data } = await admin.from('agent_registry').select('agent_name').eq('agent_name', name)
        .eq('owner_id', user.id).eq('active', true).maybeSingle()
      return !!data
    }

    if (action === 'list') {
      const { data, error } = await admin
        .from('agent_tasks')
        .select('*')
        .eq('owner_id', user.id)
        .order('created_at', { ascending: false })
        .limit(100)
      if (error) return json({ error: 'task_lookup_failed', detail: error.message }, 500)
      return json({ ok: true, tasks: data || [] })
    }

    if (action === 'create') {
      const title = String(body.title || '').trim()
      if (!title) return json({ error: 'title_required' }, 400)
      const { data, error } = await admin
        .from('agent_tasks')
        .insert({
          owner_id: user.id,
          title,
          description: body.description || null,
          priority: body.priority || 'normal',
          metadata: body.metadata || null,
        })
        .select()
        .single()
      if (error) return json({ error: 'task_creation_failed', detail: error.message }, 500)
      return json({ ok: true, task: data })
    }

    if (action === 'claim' || action === 'complete' || action === 'fail') {
      const taskId = String(body.task_id || '')
      const agentName = String(body.agent_name || '').trim()
      if (!taskId || !agentName) return json({ error: 'task_id_and_agent_name_required' }, 400)
      if (!(await registeredAgent(agentName))) return json({ error: 'agent_not_registered' }, 403)
      const task = await loadOwnTask(taskId)
      if (!task) return json({ error: 'task_not_found' }, 404)

      if (action === 'claim') {
        const decision = claimDecision(task, user.id, now)
        if (!decision.ok) {
          // An expired lease with no retries left is closed out as failed.
          if (decision.error === 'task_retries_exhausted') {
            await admin.from('agent_tasks').update({ ...failureUpdate(task), status: 'failed', updated_at: now.toISOString() })
              .eq('id', task.id).eq('status', task.status)
          }
          return json({ error: decision.error, status: task.status }, decision.error === 'task_not_found' ? 404 : 409)
        }
        // Atomic conditional update: only succeeds if the row is still in the state we validated.
        let query = admin
          .from('agent_tasks')
          .update({
            status: 'running',
            assigned_agent: agentName,
            claimed_at: now.toISOString(),
            lease_expires_at: new Date(now.getTime() + LEASE_MS).toISOString(),
            retry_count: decision.reclaimed ? task.retry_count + 1 : task.retry_count,
            updated_at: now.toISOString(),
          })
          .eq('id', task.id)
          .eq('owner_id', user.id)
          .eq('status', task.status)
        if (decision.reclaimed) query = query.lte('lease_expires_at', now.toISOString())
        const { data: updated, error: updateError } = await query.select().maybeSingle()
        if (updateError || !updated) return json({ error: 'task_claim_conflict' }, 409)
        return json({ ok: true, task: updated })
      }

      const decision = completeDecision(task, user.id, agentName, now)
      if (!decision.ok) return json({ error: decision.error }, decision.error === 'task_not_found' ? 404 : 409)

      const change = action === 'complete'
        ? (() => {
          const evidence = body.completion_evidence
          return evidence ? { status: 'completed', completion_evidence: evidence, lease_expires_at: null } : null
        })()
        : failureUpdate(task)
      if (!change) return json({ error: 'completion_evidence_required' }, 400)

      const { data, error } = await admin
        .from('agent_tasks')
        .update({ ...change, updated_at: now.toISOString() })
        .eq('id', task.id)
        .eq('owner_id', user.id)
        .eq('assigned_agent', agentName)
        .in('status', ['claimed', 'running'])
        .select()
        .maybeSingle()
      if (error || !data) return json({ error: `task_${action}_conflict` }, 409)
      return json({ ok: true, task: data })
    }

    return json({ error: 'invalid_action' }, 400)
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'dispatcher_failed' }, 500)
  }
})
