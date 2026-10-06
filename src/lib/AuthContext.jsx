import React, { createContext, useState, useContext, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { getAuthenticatedSession, supabase } from './supabase'
import { isUnlocked as readUnlocked, setUnlocked as persistUnlocked } from './security'
const AuthContext = createContext()

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState(null)
  // Local vault lock is independent of the Supabase session.
  const [isUnlocked, setIsUnlocked] = useState(() => readUnlocked())
  const navigate = useNavigate()

  useEffect(() => {
    let mounted = true
    const initAuth = async () => {
      try {
        const session = await getAuthenticatedSession()
        if (mounted) setUser(session.user || null)
      } catch (err) {
        console.error('Auth initialization error:', err)
        if (mounted) setError(err.message)
      } finally {
        if (mounted) setIsLoading(false)
      }
    }

    initAuth()

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        if (mounted) setUser(session?.user || null)
      }
    )

    return () => {
      mounted = false
      subscription?.unsubscribe()
    }
  }, [])

  const unlock = () => {
    persistUnlocked(true)
    setIsUnlocked(true)
  }

  const lock = () => {
    persistUnlocked(false)
    setIsUnlocked(false)
  }

  const login = async (email, password) => {
    try {
      setError(null)
      const { data, error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) throw error

      // Make the authenticated user available immediately instead of waiting
      // for the auth-state callback before protected panels mount.
      setUser(data.user || data.session?.user || null)

      const session = await getAuthenticatedSession()
      setUser(session.user)
      return { ...data, session }
    } catch (err) {
      setError(err.message)
      throw err
    }
  }

  const register = async (email, password) => {
    try {
      setError(null)
      const { data, error } = await supabase.auth.signUp({ email, password })
      if (error) throw error
      setUser(data.user || data.session?.user || null)
      return data
    } catch (err) {
      setError(err.message)
      throw err
    }
  }

  const logout = async () => {
    try {
      setError(null)
      await supabase.auth.signOut()
      setUser(null)
      lock()
      navigate('/login')
    } catch (err) {
      setError(err.message)
      throw err
    }
  }

  const resetPassword = async (email) => {
    try {
      setError(null)
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      })
      if (error) throw error
    } catch (err) {
      setError(err.message)
      throw err
    }
  }

  const updatePassword = async (newPassword) => {
    try {
      setError(null)
      const { error } = await supabase.auth.updateUser({ password: newPassword })
      if (error) throw error
    } catch (err) {
      setError(err.message)
      throw err
    }
  }

  const value = {
    user,
    // Keep the existing PIN-gate semantics for protected routing.
    isAuthenticated: isUnlocked,
    // Explicit Supabase session state for data/API panels.
    hasSupabaseSession: !!user,
    isUnlocked,
    isLoading,
    error,
    unlock,
    lock,
    login,
    register,
    logout,
    resetPassword,
    updatePassword,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export const useAuth = () => {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within AuthProvider')
  return context
}
