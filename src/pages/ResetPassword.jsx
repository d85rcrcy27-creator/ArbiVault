import React, { useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Lock, Loader2, AlertTriangle } from "lucide-react";
import AuthLayout from "@/components/AuthLayout";

export default function ResetPassword() {
  const [newPassword, setNewPassword] = useState(""); const [confirmPassword, setConfirmPassword] = useState(""); const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  const handleSubmit = async (e) => { e.preventDefault(); setError(""); if (newPassword !== confirmPassword) { setError("Passwords do not match"); return; } setLoading(true); try { const { data: { session } } = await supabase.auth.getSession(); if (!session) throw new Error("This reset link is invalid or has expired"); const { error: updateError } = await supabase.auth.updateUser({ password: newPassword }); if (updateError) throw updateError; await supabase.auth.signOut(); window.location.href = "/login"; } catch (err) { setError(err.message || "Failed to reset password"); } finally { setLoading(false); } };
  return <AuthLayout icon={Lock} title="New password" subtitle="Enter your new password below" footer={<Link to="/forgot-password" className="text-primary font-medium hover:underline">Request a new link</Link>}>
    {error && <div className="mb-4 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">{error}</div>}
    <form onSubmit={handleSubmit} className="space-y-4"><div className="space-y-2"><Label htmlFor="password">New Password</Label><div className="relative"><Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true" /><Input id="password" type="password" autoComplete="new-password" autoFocus placeholder="••••••••" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="pl-10 h-12" required /></div></div><div className="space-y-2"><Label htmlFor="confirm">Confirm Password</Label><Input id="confirm" type="password" autoComplete="new-password" placeholder="••••••••" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className="h-12" required /></div><Button type="submit" className="w-full h-12 font-medium" disabled={loading}>{loading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Resetting...</> : "Reset password"}</Button></form>
  </AuthLayout>;
}
