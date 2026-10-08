import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0, // Live app state must not remain fresh for minutes at a time
      gcTime: 1000 * 60 * 5, // Keep inactive cache short for live operational state
      retry: 1,
      refetchOnWindowFocus: true,
    },
    mutations: {
      retry: 1,
    },
  },
})
