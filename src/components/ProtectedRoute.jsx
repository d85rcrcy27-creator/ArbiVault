import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '@/lib/AuthContext'
import LoadingSpinner from './LoadingSpinner'

export default function ProtectedRoute() {
  const { isUnlocked, isLoading } = useAuth()

  if (isLoading) {
    return <LoadingSpinner />
  }

  return isUnlocked ? <Outlet /> : <Navigate to="/login" replace />
}
