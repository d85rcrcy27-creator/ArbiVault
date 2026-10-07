import { QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter as Router, Route, Routes, Navigate } from 'react-router-dom'
import { AuthProvider } from '@/lib/AuthContext'
import { queryClient } from '@/lib/query-client'
import ProtectedRoute from '@/components/ProtectedRoute'
import AppErrorBoundary from '@/components/AppErrorBoundary'
import PageNotFound from '@/pages/PageNotFound'
import Home from '@/pages/Home'
import Login from '@/pages/AccountLogin'
import LockScreen from '@/pages/LockScreen'
import Register from '@/pages/Register'
import ForgotPassword from '@/pages/ForgotPassword'
import ResetPassword from '@/pages/ResetPassword'

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Router>
        <AuthProvider>
          <AppErrorBoundary>
            <Routes>
            {/* Public routes */}
            <Route path="/login" element={<Login />} />
            <Route element={<ProtectedRoute requireSessionOnly />}>
              <Route path="/unlock" element={<LockScreen />} />
            </Route>
            <Route path="/register" element={<Register />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />

            {/* Protected routes */}
            <Route element={<ProtectedRoute />}>
              <Route path="/" element={<AppErrorBoundary><Home /></AppErrorBoundary>} />
            </Route>

            {/* Catch-all */}
            <Route path="/404" element={<PageNotFound />} />
            <Route path="*" element={<Navigate to="/404" replace />} />
            </Routes>
          </AppErrorBoundary>
        </AuthProvider>
      </Router>
    </QueryClientProvider>
  )
}

export default App
