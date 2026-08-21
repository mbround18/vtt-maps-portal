import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { authStore } from "@/stores/authStore";

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const [auth, setAuth] = useState(authStore.state$.value);

  useEffect(() => {
    const sub = authStore.state$.subscribe(setAuth);
    return () => sub.unsubscribe();
  }, []);

  if (!auth.checked) return null;
  if (!auth.authenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function RequireSuperAdmin({ children }: { children: React.ReactNode }) {
  const [auth, setAuth] = useState(authStore.state$.value);

  useEffect(() => {
    const sub = authStore.state$.subscribe(setAuth);
    return () => sub.unsubscribe();
  }, []);

  if (!auth.checked) return null;
  if (!auth.authenticated) return <Navigate to="/login" replace />;
  if (!auth.user?.is_super_admin) return <Navigate to="/" replace />;
  return <>{children}</>;
}
