import { lazy, Suspense, useEffect, type ComponentType, type ReactNode } from "react";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { RotateCw, ServerCrash, ShieldX } from "lucide-react";
import { ApiError, STALE_PAGE_MESSAGE, errorMessage, isStalePage } from "./lib/api";
import { RECOVERY_VARIABLE, clearNetworkRefusal, isNetworkRefusal, reportNetworkRefusal, useNetworkRefusal } from "./lib/networkRefusal";
import { AuthProvider, useAuth, useCanWrite } from "./lib/auth";
import { useSetupState } from "./lib/queries";
import { useCreateDatabaseDialog } from "./lib/createDatabase";
import { ThemeSync } from "./lib/theme";
import { ToastProvider, toast } from "./components/ui/Toast";
import { Button } from "./components/ui/Button";
import { CopyButton } from "./components/ui/CopyableField";
import { EmptyState } from "./components/ui/EmptyState";
import { BrandMark, Logo } from "./components/ui/Brand";
import { Skeleton } from "./components/ui/Skeleton";
import { PageShell } from "./components/layout/PageShell";
import { ErrorBoundary } from "./components/layout/ErrorBoundary";
import { CommandPaletteProvider } from "./components/command/CommandPalette";
import { CredentialsRevealProvider } from "./components/databases/CredentialsReveal";
import { Login } from "./pages/auth/Login";

function named<M, K extends keyof M>(load: () => Promise<M>, key: K) {
  return lazy(async () => ({ default: (await load())[key] as unknown as ComponentType }));
}

const Dashboard = named(() => import("./pages/Dashboard"), "Dashboard");
const Databases = named(() => import("./pages/Databases"), "Databases");
const DatabaseDetailPage = named(() => import("./pages/database"), "DatabaseDetailPage");
const AppAuth = named(() => import("./pages/AppAuth"), "AppAuth");
const DataApi = named(() => import("./pages/DataApi"), "DataApi");
const Storage = named(() => import("./pages/Storage"), "Storage");
const Realtime = named(() => import("./pages/Realtime"), "Realtime");
const Functions = named(() => import("./pages/Functions"), "Functions");
const Activity = named(() => import("./pages/Activity"), "Activity");
const Users = named(() => import("./pages/Users"), "Users");
const Network = named(() => import("./pages/Network"), "Network");
const Notifications = named(() => import("./pages/Notifications"), "Notifications");
const Settings = named(() => import("./pages/Settings"), "Settings");
const KitPage = import.meta.env.DEV ? named(() => import("./pages/dev/Kit"), "KitPage") : null;
const SetupWizard = named(() => import("./pages/setup/SetupWizard"), "SetupWizard");
const loadCreateDialog = () => import("./components/databases/CreateDatabaseDialog");
const CreateDatabaseDialog = lazy(async () => ({ default: (await loadCreateDialog()).CreateDatabaseDialog }));

function handleMutationError(error: unknown): void {
  reportNetworkRefusal(error);
  if (isStalePage(error)) {
    toast.warning("Reload to keep working", {
      id: "stale-page",
      description: STALE_PAGE_MESSAGE,
      duration: Infinity,
      action: { label: "Reload", onClick: () => window.location.reload() },
    });
  }
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: reportNetworkRefusal }),
  mutationCache: new MutationCache({ onError: handleMutationError }),
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status < 500) return false;
        return failureCount < 1;
      },
      refetchOnWindowFocus: false,
    },
    mutations: { retry: false },
  },
});

function FullScreenLoader() {
  return (
    <div className="flex h-dvh items-center justify-center bg-bg" role="status" aria-label="Loading LambData">
      <Logo size={28} className="animate-pulse motion-reduce:animate-none" />
    </div>
  );
}

function FullScreenError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg p-4">
      <EmptyState
        className="w-full max-w-md"
        icon={ServerCrash}
        title="LambData is not responding"
        description={errorMessage(error)}
        action={
          <Button variant="secondary" onClick={onRetry}>
            <RotateCw /> Try again
          </Button>
        }
      />
    </div>
  );
}

function AccessRefused({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-bg px-4 py-10">
      <BrandMark size="lg" />
      <div className="w-full max-w-lg space-y-5 rounded-xl border border-border bg-bg-panel p-6 sm:p-7" role="alert">
        <div className="flex items-start gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-lg border border-danger/35 bg-danger/[0.08] text-danger">
            <ShieldX aria-hidden className="size-5" />
          </div>
          <div className="min-w-0 space-y-1">
            <h1 className="text-title font-semibold text-text">Access refused by the network policy</h1>
            <p className="text-body text-text-muted">{error.message}</p>
          </div>
        </div>
        <div className="space-y-2 border-t border-border pt-5 text-body text-text-muted">
          <p className="font-medium text-text">To get back in</p>
          <ul className="list-disc space-y-1.5 pl-5">
            <li>Open the console through a connection the policy allows, such as your tailnet or Cloudflare hostname.</li>
            <li>
              Or reset the policy: set <span className="font-mono text-code text-text">{RECOVERY_VARIABLE}</span> on the
              container and restart LambData. Every connection is allowed again until you change it.
            </li>
            <li>Requests made on the server itself are always let in.</li>
          </ul>
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <CopyButton
            value={RECOVERY_VARIABLE}
            label="recovery variable"
            text="Copy variable"
            variant="ghost"
            size="md"
            className="sm:mr-auto"
          />
          <Button variant="secondary" onClick={onRetry}>
            <RotateCw /> Try again
          </Button>
        </div>
      </div>
    </div>
  );
}

function SetupGate({ children }: { children: ReactNode }) {
  const setup = useSetupState();
  const location = useLocation();
  const qc = useQueryClient();
  const refusal = useNetworkRefusal();
  const retry = () => {
    clearNetworkRefusal();
    void qc.refetchQueries({ type: "active" });
    void setup.refetch();
  };
  if (refusal) return <AccessRefused error={refusal} onRetry={retry} />;
  if (setup.isPending) return <FullScreenLoader />;
  if (setup.isError && isNetworkRefusal(setup.error)) return <AccessRefused error={setup.error} onRetry={retry} />;
  if (setup.isError) return <FullScreenError error={setup.error} onRetry={() => void setup.refetch()} />;
  const needsSetup = setup.data.needsSetup;
  if (needsSetup && location.pathname !== "/setup") return <Navigate to="/setup" replace />;
  if (!needsSetup && location.pathname === "/setup") return <Navigate to="/" replace />;
  return <>{children}</>;
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  const location = useLocation();
  if (isLoading) return <FullScreenLoader />;
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  return <>{children}</>;
}

function PageFallback() {
  return (
    <div role="status" aria-label="Loading page" className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}

function AppLayout() {
  const location = useLocation();
  const canWrite = useCanWrite();
  const createDialog = useCreateDatabaseDialog();
  useEffect(() => {
    if (!canWrite) return;
    const timer = window.setTimeout(() => void loadCreateDialog().catch(() => undefined), 2500);
    return () => window.clearTimeout(timer);
  }, [canWrite]);
  return (
    <CommandPaletteProvider>
      <PageShell>
        <ErrorBoundary resetKey={location.pathname}>
          <Suspense fallback={<PageFallback />}>
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      </PageShell>
      {createDialog.isOpen && canWrite && (
        <Suspense fallback={null}>
          <CreateDatabaseDialog open initialType={createDialog.type} onClose={createDialog.close} />
        </Suspense>
      )}
    </CommandPaletteProvider>
  );
}

function AppRoutes() {
  return (
    <Routes>
      <Route
        path="/setup"
        element={
          <Suspense fallback={<FullScreenLoader />}>
            <SetupWizard />
          </Suspense>
        }
      />
      <Route path="/login" element={<Login />} />
      {KitPage && (
        <Route
          path="/dev/kit"
          element={
            <Suspense fallback={<FullScreenLoader />}>
              <KitPage />
            </Suspense>
          }
        />
      )}
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="databases" element={<Databases />} />
        <Route path="databases/:id" element={<DatabaseDetailPage />} />
        <Route path="databases/:id/:tab/*" element={<DatabaseDetailPage />} />
        <Route path="auth" element={<AppAuth />} />
        <Route path="data-api" element={<DataApi />} />
        <Route path="storage" element={<Storage />} />
        <Route path="realtime" element={<Realtime />} />
        <Route path="functions" element={<Functions />} />
        <Route path="activity" element={<Activity />} />
        <Route path="users" element={<Users />} />
        <Route path="network/*" element={<Network />} />
        <Route path="notifications" element={<Notifications />} />
        <Route path="settings" element={<Settings />} />
      </Route>
      <Route path="/tailscale" element={<Navigate to="/network" replace />} />
      <Route path="/instances" element={<Navigate to="/databases" replace />} />
      <Route path="/schemas" element={<Navigate to="/databases" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <ThemeSync />
          <ToastProvider>
            <CredentialsRevealProvider>
              <SetupGate>
                <AppRoutes />
              </SetupGate>
            </CredentialsRevealProvider>
          </ToastProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
