import { createClient } from 'npm:@supabase/supabase-js@2.117.2'

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

    if (action === 'list') {
      const { data, error } = await admin
        .from('agent_tasks')
        .select('*')
        .or(`owner_id.eq.${user.id},owner_id.is.null`)
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

    if (action === 'claim') {
      const taskId = String(body.task_id || '')
      const agentName = String(body.agent_name || '').trim()
      if (!taskId || !agentName) return json({ error: 'task_id_and_agent_name_required' }, 400)

      const { data: task, error: fetchError } = await admin
        .from('agent_tasks')
        .select('*')
        .eq('id', taskId)
        .maybeSingle()
      if (fetchError || !task) return json({ error: 'task_not_found' }, 404)
      if (task.status !== 'pending' && task.status !== 'retrying') {
        return json({ error: 'task_not_claimable', status: task.status }, 400)
      }

      const leaseExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString()
      const { data: updated, error: updateError } = await admin
        .from('agent_tasks')
        .update({
          status: 'claimed',
          assigned_agent: agentName,
          claimed_at: new Date().toISOString(),
          lease_expires_at: leaseExpiresAt,
          updated_at: new Date().toISOString(),
        })
        .eq('id', taskId)
        .in('status', ['pending', 'retrying'])
        .select()
        .maybeSingle()

      if (updateError || !updated) return json({ error: 'task_claim_conflict' }, 409)
      return json({ ok: true, task: updated })
    }

    if (action === 'complete') {
      const taskId = String(body.task_id || '')
      const evidence = body.completion_evidence
      if (!taskId || !evidence) return json({ error: 'task_id_and_completion_evidence_required' }, 400)

      const { data, error } = await admin
        .from('agent_tasks')
        .update({
          status: 'completed',
          completion_evidence: evidence,
          updated_at: new Date().toISOString(),
        })
        .eq('id', taskId)
        .select()
        .maybeSingle()

      if (error || !data) return json({ error: 'task_completion_failed' }, 400)
      return json({ ok: true, task: data })
    }

    return json({ error: 'invalid_action' }, 400)
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'dispatcher_failed' }, 500)
  }
})
