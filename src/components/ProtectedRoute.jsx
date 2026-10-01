import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '@/lib/AuthContext'
import LoadingSpinner from './LoadingSpinner'

export default function ProtectedRoute() {
  const { isAuthenticated, isLoading } = useAuth()

  if (isLoading) {
    return <LoadingSpinner />
  }

  return isAuthenticated ? <Outlet /> : <Navigate to="/login" replace />
}
