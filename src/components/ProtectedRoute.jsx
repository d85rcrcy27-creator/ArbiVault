import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '@/lib/AuthContext'
import LoadingSpinner from './LoadingSpinner'

export default function ProtectedRoute({ requireSessionOnly = false }) {
  const { isAuthenticated, hasSupabaseSession, isLoading } = useAuth()
  const location = useLocation()

  if (isLoading) {
    return <LoadingSpinner />
  }

  // The unlock screen is intentionally available to a signed-in user whose
  // local vault is still locked. Checking isAuthenticated here would redirect
  // /unlock back to /login and can create a navigation loop.
  const allowed = requireSessionOnly ? hasSupabaseSession : isAuthenticated

  return allowed
    ? <Outlet />
    : <Navigate to="/login" replace state={{ from: location }} />
}
