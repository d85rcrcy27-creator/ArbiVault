import React, { createContext, useState, useContext, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from './supabase'
import { isUnlocked as readUnlocked, setUnlocked as persistUnlocked } from './security'

const AuthContext = createContext()

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState(null)
  // Local vault lock (biometric / PIN) — independent of the Supabase session.
  const [isUnlocked, setIsUnlocked] = useState(() => readUnlocked())
  const navigate = useNavigate()

  useEffect(() => {
    const initAuth = async () => {
      try {
        // Check current session
        const { data: { session } } = await supabase.auth.getSession()
        setUser(session?.user || null)
        setIsAuthenticated(!!session)
      } catch (err) {
        console.error('Auth initialization error:', err)
        setError(err.message)
      } finally {
        setIsLoading(false)
      }
    }

    initAuth()

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setUser(session?.user || null)
        setIsAuthenticated(!!session)
      }
    )

    return () => subscription?.unsubscribe()
  }, [])

  const login = async (email, password) => {
    try {
      setError(null)
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      })
      if (error) throw error
      return data
    } catch (err) {
      setError(err.message)
      throw err
    }
  }

  const register = async (email, password) => {
    try {
      setError(null)
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
      })
      if (error) throw error
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
      setIsAuthenticated(false)
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

  const unlock = () => {
    persistUnlocked(true)
    setIsUnlocked(true)
  }

  const lock = () => {
    persistUnlocked(false)
    setIsUnlocked(false)
  }

  const value = {
    user,
    isAuthenticated,
    isLoading,
    isUnlocked,
    unlock,
    lock,
    error,
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
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return context
}
