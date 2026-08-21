import { useEffect, useMemo, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { getJson } from "./api/client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { CookieNotice } from "./components/CookieNotice";
import { RequireAuth, RequireSuperAdmin } from "./components/RouteGuards";
import { HomePage } from "./pages/HomePage";
import { CatalogPage } from "./pages/CatalogPage";
import { MapDetailPage } from "./pages/MapDetailPage";
import { LoginPage } from "./pages/LoginPage";
import { AccountPage } from "./pages/AccountPage";
import { AdminUsersPage } from "./pages/AdminUsersPage";
import { AdminAssetsPage } from "./pages/AdminAssetsPage";
import { AdminAnalyticsPage } from "./pages/AdminAnalyticsPage";
import { AdminJobsPage } from "./pages/AdminJobsPage";
import { AdminPanelPage } from "./pages/AdminPanelPage";
import { authStore } from "./stores/authStore";

const DONATE_URL = "https://ko-fi.com/mbround18";
const GITHUB_URL = "https://github.com/MBRound18/vtt-maps";

export function App() {
  const [auth, setAuth] = useState(authStore.state$.value);
  const [stars, setStars] = useState<number | null>(null);

  useEffect(() => {
    authStore.refresh().catch(() => undefined);
    const sub = authStore.state$.subscribe(setAuth);
    return () => sub.unsubscribe();
  }, []);

  useEffect(() => {
    getJson<{ stars: number | null }>("/api/v1/public/github-stars")
      .then((payload) => setStars(payload.stars ?? null))
      .catch(() => setStars(null));
  }, []);

  const isSuperAdmin = Boolean(auth.user?.is_super_admin);
  const navLinks = useMemo(() => {
    const base = [
      { to: "/", label: "Home" },
      { to: "/catalog", label: "Catalog" }
    ];
    if (isSuperAdmin) {
      base.push(
        { to: "/admin/users", label: "Users" },
        { to: "/admin/analytics", label: "Analytics" },
        { to: "/admin/panel", label: "Admin Panel" }
      );
    }
    if (!auth.authenticated) {
      base.push({ to: "/login", label: "Login" });
    }
    return base;
  }, [auth.authenticated, isSuperAdmin]);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex min-h-screen flex-col bg-background text-foreground">
        <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
            <div className="flex items-center gap-4">
              <NavLink to="/" className="flex items-center gap-2 font-semibold tracking-tight">
                <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground">
                  M
                </span>
                <span>VTT Maps</span>
              </NavLink>
              <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
                <a href={DONATE_URL} target="_blank" rel="noreferrer noopener">
                  Donate
                </a>
              </Button>
            </div>
            <div className="flex items-center gap-1 sm:gap-2">
              {navLinks.map((link) => (
                <NavLink
                  key={link.to}
                  to={link.to}
                  end={link.to === "/"}
                  className={({ isActive }) =>
                    cn(
                      "rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground",
                      isActive && "bg-accent text-foreground"
                    )
                  }
                >
                  {link.label}
                </NavLink>
              ))}
              {!isSuperAdmin ? (
                <Button asChild variant="outline" size="sm" className="ml-1 hidden md:inline-flex">
                  <a href={GITHUB_URL} target="_blank" rel="noreferrer noopener">
                    GitHub{stars !== null ? <Badge variant="secondary" className="ml-1.5">{stars}</Badge> : null}
                  </a>
                </Button>
              ) : null}
              {auth.authenticated ? (
                <NavLink
                  to="/account"
                  aria-label="Your profile"
                  className="ml-1 rounded-full ring-offset-2 ring-offset-background transition-shadow hover:ring-2 hover:ring-primary/60 focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:outline-none"
                >
                  <Avatar>
                    <AvatarImage src={auth.user?.avatar_url ?? undefined} alt={auth.user?.username ?? "Profile"} />
                    <AvatarFallback>{(auth.user?.username ?? "?").slice(0, 1).toUpperCase()}</AvatarFallback>
                  </Avatar>
                </NavLink>
              ) : null}
            </div>
          </nav>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/catalog" element={<CatalogPage />} />
            <Route path="/maps/:id" element={<MapDetailPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route
              path="/account"
              element={
                <RequireAuth>
                  <AccountPage />
                </RequireAuth>
              }
            />
            <Route
              path="/admin/users"
              element={
                <RequireSuperAdmin>
                  <AdminUsersPage />
                </RequireSuperAdmin>
              }
            />
            <Route
              path="/admin/assets"
              element={
                <RequireSuperAdmin>
                  <AdminAssetsPage />
                </RequireSuperAdmin>
              }
            />
            <Route
              path="/admin/analytics"
              element={
                <RequireSuperAdmin>
                  <AdminAnalyticsPage />
                </RequireSuperAdmin>
              }
            />
            <Route
              path="/admin/jobs"
              element={
                <RequireSuperAdmin>
                  <AdminJobsPage />
                </RequireSuperAdmin>
              }
            />
            <Route
              path="/admin/panel"
              element={
                <RequireSuperAdmin>
                  <AdminPanelPage />
                </RequireSuperAdmin>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>

        <footer className="border-t border-border/60 py-6">
          <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-4 text-sm text-muted-foreground sm:flex-row sm:px-6">
            <span>MBRound18 made with ❤️</span>
            <span>All maps published under the Creative Commons license</span>
            <a
              className="font-medium text-foreground underline-offset-4 hover:underline"
              href={DONATE_URL}
              target="_blank"
              rel="noreferrer noopener"
            >
              Donate
            </a>
          </div>
        </footer>
        <CookieNotice />
        <Toaster />
      </div>
    </TooltipProvider>
  );
}
