import React, { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabaseClient'

export default function Tasks() {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState('normal')
  const queryClient = useQueryClient()

  const { data: tasks = [], isLoading } = useQuery({
    queryKey: ['agent-tasks'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_tasks')
        .select('*')
        .order('created_at', { ascending: false })
      if (error) throw error
      return data || []
    },
  })

  const createTask = useMutation({
    mutationFn: async (newTask) => {
      const { data, error } = await supabase.from('agent_tasks').insert([newTask]).select()
      if (error) throw error
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries(['agent-tasks'])
      setTitle('')
      setDescription('')
    },
  })

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!title.trim()) return
    createTask.mutate({ title, description, priority, status: 'pending' })
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-white">Agent Task Queue &amp; Orchestration</h1>
      </div>

      <form onSubmit={handleSubmit} className="bg-slate-900 p-4 rounded-lg border border-slate-800 space-y-4">
        <h2 className="text-lg font-semibold text-slate-200">Create New Agent Task</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <input
            type="text"
            placeholder="Task Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded px-3 py-2 text-white"
            required
          />
          <input
            type="text"
            placeholder="Description / Context"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded px-3 py-2 text-white"
          />
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded px-3 py-2 text-white"
          >
            <option value="low">Low Priority</option>
            <option value="normal">Normal Priority</option>
            <option value="high">High Priority</option>
            <option value="p0">P0 Urgent</option>
          </select>
        </div>
        <button type="submit" className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded font-medium">
          Enqueue Task
        </button>
      </form>

      <div className="bg-slate-900 rounded-lg border border-slate-800 overflow-hidden">
        <div className="p-4 border-b border-slate-800 font-semibold text-slate-200">Task Queue ({tasks.length})</div>
        {isLoading ? (
          <div className="p-4 text-slate-400">Loading tasks...</div>
        ) : tasks.length === 0 ? (
          <div className="p-4 text-slate-400">No agent tasks found in queue.</div>
        ) : (
          <div className="divide-y divide-slate-800">
            {tasks.map((task) => (
              <div key={task.id} className="p-4 flex justify-between items-center">
                <div>
                  <div className="font-medium text-white">{task.title}</div>
                  <div className="text-sm text-slate-400">{task.description || 'No description'}</div>
                  <div className="text-xs text-slate-500 mt-1">
                    Status: <span className="text-indigo-400 font-semibold">{task.status}</span> | Priority: {task.priority} | Agent: {task.assigned_agent || 'Unassigned'}
                  </div>
                </div>
                <div className="text-xs text-slate-500">
                  {new Date(task.created_at).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
