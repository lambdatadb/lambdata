import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ExperienceLevel, User } from "@lambdata/shared";
import { FolderInput, RotateCcw } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { roleLabel, useAuth } from "../lib/auth";
import { formatBytes } from "../lib/format";
import { PageHeader } from "../components/layout/PageShell";
import {
  Alert,
  Button,
  Card,
  DescriptionItem,
  DescriptionList,
  Field,
  SegmentedControl,
  Skeleton,
  Switch,
  useToast,
} from "../components/ui";
import { AppearanceCard, useUpdateMe } from "../components/settings/AppearanceCard";
import { PasswordForm } from "../components/settings/PasswordForm";
import { SettingsSection } from "../components/settings/SettingsSection";
import { SignOutEverywhereCard } from "../components/settings/SignOutEverywhereCard";
import { StorageMigrationDialog } from "../components/settings/StorageMigrationDialog";
import { CheckpointLimitsCard } from "../components/settings/CheckpointLimitsCard";
import { queryKeys, useAppSettings } from "../lib/queries";

export function Settings() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [moveOpen, setMoveOpen] = useState(false);

  const settingsQuery = useAppSettings();
  const settings = settingsQuery.data;

  const updateSettings = useMutation({
    mutationFn: (body: { dashboardShowAddresses: boolean }) => api.patch("/settings", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.settings });
      qc.invalidateQueries({ queryKey: queryKeys.dashboardSummary });
    },
  });

  if (!user) return null;
  const isAdmin = user.role === "admin";

  return (
    <>
      <PageHeader title="Settings" subtitle="Your account, how LambData looks, and where it keeps its data." />
      <div className="pb-6">
        <SettingsSection id="profile" title="Profile" description="Your sign-in and how much the console explains.">
          <ProfileCard key={user.experienceLevel} user={user} />
        </SettingsSection>

        <SettingsSection
          id="password"
          title="Password"
          description="You need your current password to set a new one. Changing it signs out your other sessions."
        >
          <PasswordForm user={user} />
          <SignOutEverywhereCard />
        </SettingsSection>

        <SettingsSection id="appearance" title="Appearance" description="Saved to your account, so it follows you between browsers.">
          <AppearanceCard user={user} />
        </SettingsSection>

        <SettingsSection id="dashboard" title="Dashboard" description="Shared by everyone who signs in to this instance.">
          <Card>
            {settingsQuery.isError ? (
              <SettingsError onRetry={() => settingsQuery.refetch()} error={settingsQuery.error} />
            ) : (
              <Switch
                checked={settings?.dashboardShowAddresses ?? false}
                disabled={!isAdmin || !settings || updateSettings.isPending}
                onCheckedChange={(dashboardShowAddresses) =>
                  updateSettings.mutate(
                    { dashboardShowAddresses },
                    {
                      onSuccess: () =>
                        toast.success(dashboardShowAddresses ? "Addresses shown on the dashboard" : "Addresses hidden from the dashboard"),
                      onError: (e) => toast.error(errorMessage(e, "Could not save the setting")),
                    },
                  )
                }
                label="Show connection addresses"
                description={
                  isAdmin
                    ? "Shows the public database endpoint under the dashboard title, and the tailnet endpoint while Tailscale is connected."
                    : "Shows the database endpoints under the dashboard title. Only admins can change this."
                }
              />
            )}
          </Card>
        </SettingsSection>

        <SettingsSection
          id="storage"
          title="Storage"
          description="Where LambData keeps the MariaDB data, its own metadata, checkpoints and the encryption key."
        >
          <Card>
            {settingsQuery.isError ? (
              <SettingsError onRetry={() => settingsQuery.refetch()} error={settingsQuery.error} />
            ) : (
              <div className="space-y-4">
                <DescriptionList>
                  <DescriptionItem term="Data directory" mono>
                    {settings ? <span className="break-all">{settings.dataDir}</span> : <Skeleton className="ml-auto h-4 w-48" />}
                  </DescriptionItem>
                  <DescriptionItem term="Pointer file" mono>
                    {settings ? (
                      <span className="break-all text-text-muted">{settings.pointerPath}</span>
                    ) : (
                      <Skeleton className="ml-auto h-4 w-40" />
                    )}
                  </DescriptionItem>
                  <DescriptionItem term="Free space" mono>
                    {settings ? (settings.dataDirFreeBytes != null ? formatBytes(settings.dataDirFreeBytes) : "unknown") : <Skeleton className="ml-auto h-4 w-16" />}
                  </DescriptionItem>
                </DescriptionList>
                {isAdmin && (
                  <div className="flex justify-end border-t border-border pt-4">
                    <Button variant="secondary" size="sm" disabled={!settings} onClick={() => setMoveOpen(true)}>
                      <FolderInput aria-hidden /> Move data directory
                    </Button>
                  </div>
                )}
              </div>
            )}
          </Card>
        </SettingsSection>

        <SettingsSection
          id="checkpoint-limits"
          title="Checkpoint limits"
          description="Ceilings on the automatic checkpoint policies database owners set, so history cannot fill the disk. Admins can set any policy."
        >
          <CheckpointLimitsCard limits={settings?.limits} isAdmin={isAdmin} />
        </SettingsSection>

        <SettingsSection id="system" title="System">
          <Card>
            {settingsQuery.isError ? (
              <SettingsError onRetry={() => settingsQuery.refetch()} error={settingsQuery.error} />
            ) : (
              <DescriptionList>
                <DescriptionItem term="MariaDB port" mono>
                  {settings ? settings.mariadbPort : <Skeleton className="ml-auto h-4 w-12" />}
                </DescriptionItem>
                <DescriptionItem term="Setup">
                  {settings ? (settings.setupComplete ? "Complete" : "Not finished") : <Skeleton className="ml-auto h-4 w-16" />}
                </DescriptionItem>
                <DescriptionItem term="Tailscale">
                  {settings ? (
                    <Link to="/network#tailscale" className="underline decoration-border-control underline-offset-4 hover:text-text">
                      {settings.tailscaleEnabled ? "Enabled" : "Off"}
                    </Link>
                  ) : (
                    <Skeleton className="ml-auto h-4 w-12" />
                  )}
                </DescriptionItem>
              </DescriptionList>
            )}
          </Card>
        </SettingsSection>
      </div>
      <StorageMigrationDialog open={moveOpen} onClose={() => setMoveOpen(false)} current={settings?.dataDir ?? ""} />
    </>
  );
}

function ProfileCard({ user }: { user: User }) {
  const toast = useToast();
  const update = useUpdateMe(user);
  const [level, setLevel] = useState<ExperienceLevel>(user.experienceLevel);

  return (
    <Card className="space-y-5">
      <DescriptionList>
        <DescriptionItem term="Email" mono>
          {user.email}
        </DescriptionItem>
        <DescriptionItem term="Display name">{user.displayName || <span className="text-text-subtle">not set</span>}</DescriptionItem>
        <DescriptionItem term="Role">{roleLabel(user.role)}</DescriptionItem>
      </DescriptionList>
      <Field
        label="Interface"
        id="experience-level"
        hint={level === "novice" ? "Database terms come with plain-language explanations." : "Terse labels for people who know MariaDB."}
        className="border-t border-border pt-4"
      >
        <SegmentedControl
          id="experience-level"
          aria-label="Interface"
          className="w-fit"
          value={level}
          disabled={update.isPending}
          onValueChange={(value) => {
            const next = value as ExperienceLevel;
            const previous = level;
            setLevel(next);
            update.mutate(
              { experienceLevel: next },
              {
                onSuccess: () => toast.success(next === "novice" ? "Explanations turned on" : "Explanations turned off"),
                onError: (e) => {
                  setLevel(previous);
                  toast.error(errorMessage(e, "Could not save the setting"));
                },
              },
            );
          }}
          options={[
            { value: "advanced", label: "Advanced" },
            { value: "novice", label: "Novice" },
          ]}
        />
      </Field>
    </Card>
  );
}

function SettingsError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <Alert
      variant="danger"
      title="Could not load instance settings"
      action={
        <Button size="xs" variant="secondary" onClick={onRetry}>
          <RotateCcw aria-hidden /> Retry
        </Button>
      }
    >
      {errorMessage(error, "The server did not answer.")}
    </Alert>
  );
}
