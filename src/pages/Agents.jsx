import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabaseClient'

export default function Agents() {
  const { data: bots = [], isLoading } = useQuery({
    queryKey: ['strategy-bots-roster'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('arbivault_strategy_bots')
        .select('*')
      if (error) throw error
      return data || []
    },
  })

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-white">Agent Roster &amp; Dispatch Monitor</h1>
      <div className="bg-slate-900 rounded-lg border border-slate-800 overflow-hidden">
        <div className="p-4 border-b border-slate-800 font-semibold text-slate-200">Registered Strategy Bots / Agents ({bots.length})</div>
        {isLoading ? (
          <div className="p-4 text-slate-400">Loading agent roster...</div>
        ) : bots.length === 0 ? (
          <div className="p-4 text-slate-400">No strategy bots / agents registered.</div>
        ) : (
          <div className="divide-y divide-slate-800">
            {bots.map((bot) => (
              <div key={bot.id} className="p-4 flex justify-between items-center">
                <div>
                  <div className="font-medium text-white">{bot.name || bot.strategy}</div>
                  <div className="text-sm text-slate-400">Strategy: {bot.strategy} | ID: {bot.id}</div>
                  <div className="text-xs text-slate-500 mt-1">
                    Enabled: {bot.enabled ? 'Yes' : 'No'} | Execution Enabled: {bot.execution_enabled ? 'Yes' : 'No'}
                  </div>
                </div>
                <div className="text-xs px-2.5 py-1 rounded bg-slate-800 text-slate-300">
                  {bot.enabled ? 'Active' : 'Inactive'}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
