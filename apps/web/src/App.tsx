import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth";
import { ToastProvider } from "./components/ui/Toast";
import { api } from "./lib/api";
import { PageShell } from "./components/layout/PageShell";
import { Spinner } from "./components/ui/Spinner";

import { Login } from "./pages/auth/Login";
import { SetupWizard } from "./pages/setup/SetupWizard";
import { Dashboard } from "./pages/Dashboard";
import { Databases } from "./pages/Databases";
import { DatabaseDetail } from "./pages/DatabaseDetail";
import { AppAuth } from "./pages/AppAuth";
import { DataApi } from "./pages/DataApi";
import { Storage } from "./pages/Storage";
import { Realtime } from "./pages/Realtime";
import { Functions } from "./pages/Functions";
import { Users } from "./pages/Users";
import { Settings } from "./pages/Settings";
import { Tailscale } from "./pages/Tailscale";
import { Activity } from "./pages/Activity";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
  },
});

function FullScreenLoader() {
  return (
    <div className="h-screen flex items-center justify-center">
      <Spinner className="size-6" />
    </div>
  );
}

function SetupGate({ children }: { children: React.ReactNode }) {
  const { data, isLoading } = useQuery({
    queryKey: ["setup", "state"],
    queryFn: () => api.get<{ needsSetup: boolean }>("/setup/state"),
  });
  const location = useLocation();
  if (isLoading) return <FullScreenLoader />;
  if (data?.needsSetup && location.pathname !== "/setup") {
    return <Navigate to="/setup" replace />;
  }
  if (!data?.needsSetup && location.pathname === "/setup") {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  const location = useLocation();
  if (isLoading) return <FullScreenLoader />;
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/setup" element={<SetupWizard />} />
      <Route path="/login" element={<Login />} />

      <Route
        path="/"
        element={
          <RequireAuth>
            <PageShell><Dashboard /></PageShell>
          </RequireAuth>
        }
      />
      <Route
        path="/databases"
        element={
          <RequireAuth>
            <PageShell><Databases /></PageShell>
          </RequireAuth>
        }
      />
      <Route
        path="/instances"
        element={
          <RequireAuth>
            <PageShell><Databases /></PageShell>
          </RequireAuth>
        }
      />
      <Route
        path="/schemas"
        element={
          <RequireAuth>
            <PageShell><Databases /></PageShell>
          </RequireAuth>
        }
      />
      <Route
        path="/databases/:id"
        element={
          <RequireAuth>
            <PageShell><DatabaseDetail /></PageShell>
          </RequireAuth>
        }
      />
      <Route
        path="/storage"
        element={
          <RequireAuth>
            <PageShell><Storage /></PageShell>
          </RequireAuth>
        }
      />
      <Route
        path="/auth"
        element={
          <RequireAuth>
            <PageShell><AppAuth /></PageShell>
          </RequireAuth>
        }
      />
      <Route
        path="/data-api"
        element={
          <RequireAuth>
            <PageShell><DataApi /></PageShell>
          </RequireAuth>
        }
      />
      <Route
        path="/realtime"
        element={
          <RequireAuth>
            <PageShell><Realtime /></PageShell>
          </RequireAuth>
        }
      />
      <Route
        path="/functions"
        element={
          <RequireAuth>
            <PageShell><Functions /></PageShell>
          </RequireAuth>
        }
      />
      <Route
        path="/users"
        element={
          <RequireAuth>
            <PageShell><Users /></PageShell>
          </RequireAuth>
        }
      />
      <Route
        path="/tailscale"
        element={
          <RequireAuth>
            <PageShell><Tailscale /></PageShell>
          </RequireAuth>
        }
      />
      <Route
        path="/settings"
        element={
          <RequireAuth>
            <PageShell><Settings /></PageShell>
          </RequireAuth>
        }
      />
      <Route
        path="/activity"
        element={
          <RequireAuth>
            <PageShell><Activity /></PageShell>
          </RequireAuth>
        }
      />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <ToastProvider>
            <SetupGate>
              <AppRoutes />
            </SetupGate>
          </ToastProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
