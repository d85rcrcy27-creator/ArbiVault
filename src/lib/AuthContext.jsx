import React, { createContext, useState, useContext, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { getAuthenticatedSession, supabase } from './supabase'
import { isUnlocked as readUnlocked, setUnlocked as persistUnlocked } from './security'
import { ensureCanonicalPasskeyOrigin } from './passkey'
const AuthContext = createContext()

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState(null)
  const [isUnlocked, setIsUnlocked] = useState(() => readUnlocked())
  const navigate = useNavigate()

  useEffect(() => {
    let mounted = true

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        if (!mounted) return
        setUser(session?.user || null)
        if (session?.user) setError(null)
      }
    )

    const initAuth = async () => {
      try {
        const session = await getAuthenticatedSession()
        if (mounted) {
          setUser(session.user || null)
          setError(null)
        }
      } catch (err) {
        console.error('Auth initialization error:', err)
        if (mounted) {
          setUser(null)
          setError(null)
        }
      } finally {
        if (mounted) setIsLoading(false)
      }
    }

    initAuth()

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
      setUser(data.user || data.session?.user || null)
      const session = await getAuthenticatedSession()
      setUser(session.user)
      return { ...data, session }
    } catch (err) {
      setError(err.message)
      throw err
    }
  }

  const loginWithPasskey = async () => {
    try {
      setError(null)
      if (!ensureCanonicalPasskeyOrigin()) return { redirected: true }
      if (!window.isSecureContext) {
        throw new Error('Passkey sign-in requires a secure HTTPS connection.')
      }
      if (!window.PublicKeyCredential || !navigator.credentials) {
        throw new Error('This browser does not support passkey sign-in.')
      }

      const { data, error } = await supabase.auth.signInWithPasskey()
      if (error) throw error

      const session = data?.session || await getAuthenticatedSession()
      if (!session?.access_token) {
        throw new Error('Passkey sign-in succeeded without an authenticated session.')
      }

      setUser(data?.user || session.user || null)
      return { ...data, session }
    } catch (err) {
      setError(err.message)
      throw err
    }
  }

  const registerPasskey = async () => {
    try {
      setError(null)
      if (!user) throw new Error('Sign in before registering a passkey.')
      if (!ensureCanonicalPasskeyOrigin()) return { redirected: true }
      if (!window.isSecureContext) {
        throw new Error('Passkey setup requires a secure HTTPS connection.')
      }
      if (!window.PublicKeyCredential || !navigator.credentials) {
        throw new Error('This browser does not support passkeys.')
      }

      const { data, error } = await supabase.auth.registerPasskey()
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
    isAuthenticated: !!user && isUnlocked,
    hasSupabaseSession: !!user,
    isUnlocked,
    isLoading,
    error,
    unlock,
    lock,
    login,
    loginWithPasskey,
    registerPasskey,
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
