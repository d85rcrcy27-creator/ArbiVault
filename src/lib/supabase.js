import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables')
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})

// Centralize refreshes so multiple panels cannot race the same refresh token.
let refreshPromise = null

export async function getAuthenticatedSession() {
  const { data, error } = await supabase.auth.getSession()
  if (error) throw error
  if (data.session?.access_token) return data.session

  if (!refreshPromise) {
    refreshPromise = supabase.auth.refreshSession().finally(() => {
      refreshPromise = null
    })
  }

  const { data: refreshed, error: refreshError } = await refreshPromise
  if (refreshError) throw refreshError
  if (!refreshed.session?.access_token) {
    throw new Error('Supabase auth session unavailable. Please sign in again.')
  }

  return refreshed.session
}
