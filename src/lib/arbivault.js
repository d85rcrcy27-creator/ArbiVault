import { supabase } from '@/lib/supabase'

export async function currentUserId() {
  const { data, error } = await supabase.auth.getUser()
  if (error) throw error
  if (!data.user) throw new Error('Authentication required')
  return data.user.id
}

export async function listWallets() {
  const { data, error } = await supabase
    .from('wallets')
    .select('id,chain,address,label,status,is_hot,custody_type,last_balance,balance_usd,last_verified_at,created_at')
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

export async function listApprovedWallets() {
  const { data, error } = await supabase
    .from('approved_wallets')
    .select('id,chain,address,label,status,approved_at,activation_at,is_primary,created_at')
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

export async function addApprovedWallet({ chain, address, label }) {
  const { data, error } = await supabase.rpc('add_approved_destination', {
    p_chain: chain,
    p_address: address,
    p_label: label || null,
  })
  if (error) throw error
  return data
}

export async function activateApprovedWallet(id, makePrimary = true) {
  const { data, error } = await supabase.rpc('approve_approved_destination', {
    p_approved_wallet_id: id,
    p_make_primary: makePrimary,
  })
  if (error) throw error
  return data
}

export async function createBotSkill({ botConfigId = null, name, description = '', conditions = [], actions = [], riskLimits = {}, cooldownSeconds = 30 }) {
  const ownerId = await currentUserId()
  const { data, error } = await supabase
    .from('bot_skills')
    .insert({
      owner_id: ownerId,
      bot_config_id: botConfigId,
      name,
      description,
      conditions,
      actions,
      risk_limits: riskLimits,
      cooldown_seconds: cooldownSeconds,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function updateBotSkill(id, updates) {
  const { data, error } = await supabase
    .from('bot_skills')
    .update(updates)
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  return data
}

export async function deleteBotSkill(id) {
  const { error } = await supabase.from('bot_skills').delete().eq('id', id)
  if (error) throw error
}

export async function listBotSkills() {
  const { data, error } = await supabase
    .from('bot_skills')
    .select('*')
    .order('created_at', { ascending: true })
  if (error) throw error
  return data || []
}

export async function recordSimulatedTrade(trade) {
  const ownerId = await currentUserId()
  const { data, error } = await supabase
    .from('trades')
    .insert({
      owner_id: ownerId,
      bot_config_id: trade.botConfigId || null,
      bot_skill_id: trade.botSkillId || null,
      chain: trade.chain || 'bnb',
      strategy: trade.strategy || 'liquidity_fragmentation',
      pair: trade.pair,
      notional_amount: trade.notionalAmount ?? null,
      borrowed_amount: trade.borrowedAmount ?? null,
      gross_profit: trade.grossProfit ?? null,
      fees_paid: trade.feesPaid ?? null,
      net_profit: trade.pnl ?? 0,
      execution_time_ms: trade.executionTimeMs ?? null,
      status: 'simulated',
      execution_mode: 'simulated',
      tx_hash: null,
      metadata: {
        buyExchange: trade.buyExchange,
        sellExchange: trade.sellExchange,
        spreadPct: trade.spreadPct,
      },
    })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function listTrades(limit = 100) {
  const { data, error } = await supabase
    .from('trades')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return data || []
}
