# Unraid deployment

KilnDB provides an Unraid Docker template backed by `ghcr.io/maybegrim/kilndb:latest`. The template keeps all application and Tailscale state in the same appdata directory.

## Install the template

Run this from the Unraid terminal:

```bash
mkdir -p /boot/config/plugins/dockerMan/templates-user
curl -fsSL \
  https://raw.githubusercontent.com/maybegrim/KilnDB/main/unraid/kilndb.xml \
  -o /boot/config/plugins/dockerMan/templates-user/my-KilnDB.xml
```

Open **Docker → Add Container**, select **KilnDB**, and review these defaults:

| Setting | Default |
|---|---|
| Repository | `ghcr.io/maybegrim/kilndb:latest` |
| Network | `Bridge` |
| Web UI | Host `4317` → container `4317` |
| Data | `/mnt/user/appdata/kilndb` → `/data` |
| Secure cookies | `0` |
| Privileged | Off |

Apply the template, open `http://<unraid-ip>:4317`, and complete KilnDB's first-run setup.

## Native Tailscale integration

Unraid 7.2 or newer can inject and manage Tailscale inside the KilnDB container. KilnDB remains unprivileged and uses its normal entrypoint after Unraid's Tailscale hook finishes.

1. Edit the KilnDB container and enable **Use Tailscale**.
2. Choose a unique Tailscale hostname.
3. Leave **Be a Tailscale Exit Node** disabled.
4. Leave userspace networking enabled unless you specifically need full tailnet DNS or outbound connectivity.
5. Optionally select **Serve** and use port `4317` to expose the console through tailnet-only HTTPS.
6. If Serve uses HTTPS, set the KilnDB **Secure Cookies** variable to `1`.
7. Apply the template and open the container log.
8. Follow the Tailscale authentication link shown during first startup.

The template fixes the Tailscale state directory at `/data/.tailscale_state`, so the container keeps its identity across updates and recreation. When native integration is active, use the Unraid template to manage Tailscale; KilnDB reports its status without offering conflicting up/down controls.

Serve and Funnel are different exposure modes. Serve is restricted to your tailnet. Funnel exposes the service publicly and should remain disabled unless that is explicitly intended.

## Updates

Use **Docker → Check for Updates** in Unraid. The template tracks the `latest` GHCR image published from KilnDB's `main` branch.

To force a refresh from the terminal:

```bash
docker pull ghcr.io/maybegrim/kilndb:latest
```

Then edit the container and apply the template again. The `/mnt/user/appdata/kilndb` bind mount is preserved.

## Backups

Stop KilnDB before taking a filesystem-level backup and copy the complete appdata directory. It includes MariaDB, metadata, snapshots, uploaded objects, functions, the encryption key, and the Tailscale device state.

```bash
docker stop KilnDB
tar -C /mnt/user/appdata -czf /mnt/user/backups/kilndb-appdata.tar.gz kilndb
docker start KilnDB
```
