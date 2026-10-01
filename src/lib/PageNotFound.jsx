import { useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

export default function PageNotFound() {
  const location = useLocation(); const pageName = location.pathname.substring(1);
  const { data: authData, isFetched } = useQuery({ queryKey: ['user'], queryFn: async () => { const { data } = await supabase.auth.getUser(); return { user: data.user, isAuthenticated: !!data.user }; } });
  return <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50"><div className="max-w-md w-full"><div className="text-center space-y-6"><div className="space-y-2"><h1 className="text-7xl font-light text-slate-300">404</h1><div className="h-0.5 w-16 bg-slate-200 mx-auto" /></div><div className="space-y-3"><h2 className="text-2xl font-medium text-slate-800">Page Not Found</h2><p className="text-slate-600 leading-relaxed">The page <span className="font-medium text-slate-700">"{pageName}"</span> could not be found in this application.</p></div>{isFetched && authData.isAuthenticated && authData.user?.role === 'admin' && <div className="mt-8 p-4 bg-slate-100 rounded-lg border border-slate-200"><p className="text-sm font-medium text-slate-700">Admin Note</p><p className="text-sm text-slate-600">This page could not be found.</p></div>}<div className="pt-6"><button onClick={() => window.location.href = '/'} className="inline-flex items-center px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50">Go Home</button></div></div></div></div>;
}
