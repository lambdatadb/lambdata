# Upgrading from KilnDB

LambData is the new name of KilnDB. An existing KilnDB install upgrades in place: your databases, users, settings, credentials and files stay where they are. A few things behave differently afterwards, and a few need a decision from you. Read this page once before you switch.

## Before you start

1. **Back up the data folder.** Stop the container, copy the whole folder (or Docker volume), then continue. The upgrade changes how some secrets are stored, so this copy is the only clean way back to KilnDB. See [Back up first](#back-up-first) for the commands.
2. **Give the container time to stop.** LambData shuts MariaDB down cleanly, which can take longer than Docker's default of 10 seconds. Allow at least 30 seconds: `stop_grace_period` in Compose (the included file uses 45 seconds), `--stop-timeout` on `docker run`, or `--stop-timeout=45` under **Extra Parameters** on Unraid.
3. **Switch deliberately.** The old KilnDB image is no longer published. It stays frozen at the last KilnDB version, and an existing KilnDB container keeps running that version until you change its image to `ghcr.io/lambdatadb/lambdata:latest` yourself. Nothing upgrades behind your back.

You do not need to rename anything. The data path and every `KILNDB_*` variable can stay as they are, and on Unraid so can the container's name.

## Back up first

Unraid (container named `KilnDB`, data in `/mnt/user/appdata/kilndb`), from the Unraid terminal:

```bash
docker stop KilnDB
mkdir -p /mnt/user/backups
tar -C /mnt/user/appdata -czf /mnt/user/backups/kilndb-before-lambdata.tar.gz kilndb
```

Docker Compose (the KilnDB file stored everything in the volume `kilndb_kilndb-data`), from the repository folder:

```bash
docker compose down
docker run --rm -v kilndb_kilndb-data:/data:ro -v "$PWD":/backup alpine \
  tar -czf /backup/kilndb-before-lambdata.tar.gz -C /data .
```

`docker run` (volume `kilndb-data`):

```bash
docker stop kilndb
docker run --rm -v kilndb-data:/data:ro -v "$PWD":/backup alpine \
  tar -czf /backup/kilndb-before-lambdata.tar.gz -C /data .
```

`docker compose down` without `-v` keeps the volume. Never add `-v` here: it deletes the data.

## Switch to LambData

### Unraid

1. On the **Docker** tab, click the KilnDB icon and choose **Edit**.
2. Change **Repository** to `ghcr.io/lambdatadb/lambdata:latest`.
3. Leave the data path (`/mnt/user/appdata/kilndb` mapped to `/data`), the port and the variables as they are.
4. Under **Extra Parameters** (switch to the advanced view at the top right), add `--stop-timeout=45`.
5. Click **Apply**.

If you would rather install from the new LambData template, first remove the old container (its appdata folder is not touched), then set **LambData Data** to your existing `/mnt/user/appdata/kilndb` folder. Using the same appdata path keeps your data. Never run the old and the new container against the same folder at the same time.

More detail: [Unraid deployment](unraid.md).

### Docker Compose

The new `docker-compose.yml` declares the volume with its old Docker name, `kilndb_kilndb-data`, so it finds your existing data. The old container is called `kilndb` and the new one `lambdata`, so stop the old one first (the backup step above already did).

```bash
git remote set-url origin https://github.com/lambdatadb/lambdata.git
git pull
docker compose up -d --build
```

Compose prints a warning that the volume "already exists but was created for project kilndb". That is expected: it is your data. If you keep your own copy of the Compose file, add `stop_grace_period: 45s` to the service and keep pointing it at the same volume.

### docker run

Remove the old container (the volume stays) and start the new image on the same volume:

```bash
docker rm kilndb
docker run -d \
  --name lambdata \
  --restart unless-stopped \
  --stop-timeout 45 \
  -p 4317:4317 \
  -v kilndb-data:/data \
  ghcr.io/lambdatadb/lambdata:latest
```

## What happens at the first start

Watch the container log the first time (`docker logs -f <name>`, or the Logs entry on Unraid). LambData does the following on its own:

- **MariaDB.** The image runs MariaDB 11.8, the same major version as the last KilnDB image, now pinned so a rebuild cannot change it silently. If a future image brings a newer MariaDB than the one that last wrote your data folder, LambData runs MariaDB's own upgrade step (`mariadb-upgrade`) before anything else uses the database.
- **Admin account inside MariaDB.** LambData creates its internal account `lambdata_root` and removes the old `kilndb_root` once the new one works. The old account is kept if it is the definer of views, routines, triggers or events. Each database's own user (the `kdb_` names) is unchanged; new databases get `ld_` users.
- **Secrets.** Signing secrets that KilnDB stored in plain text are encrypted with your `master.key` in place. Console sessions and App Auth tokens issued before the upgrade keep working.
- **App Auth issuer.** An install that already used App Auth keeps issuing tokens with its old issuer (`kilndb-app-auth`), so apps that check the issuer keep working. Tokens with either issuer are accepted.
- **Snapshots become checkpoints.** Each KilnDB snapshot is turned into a checkpoint in that database's History, with the message "Snapshot from <date> UTC". The original file is moved to `snapshots/converted/` in the data folder and kept for 30 days. A snapshot that cannot be converted is listed in that database's History with the reason; its file is left untouched and LambData tries again at every start and about once an hour while it runs.
- **Fresh checkpoints.** A few minutes after the start, LambData takes an automatic checkpoint of every database that has tables and no automatic checkpoint from the last day, one at a time, smallest first.
- **Mirrors.** The views, routines, triggers and events of each mirror are moved onto the mirror's own MariaDB account. Mirrors made by KilnDB, including mirrors of another database on the same server, work straight after the upgrade, without waiting for their next sync.
- **Health check.** The container's health check now reports unhealthy while MariaDB is down or does not answer within 2 seconds, instead of always reporting healthy.

## What you need to check afterwards

### Reload open browser tabs

Console tabs that were open across the upgrade need a reload before they work again.

### The Data API is closed by default

KilnDB let any signed-in app user read and write every table that had no Data API policy. LambData refuses those requests. Tables that already had a policy keep following it.

- Your apps get HTTP 403 with a message that names the table and points to the Data API page.
- The **Data API** page lists what was refused since the upgrade, per table and operation, with how many times and when.
- To reopen, either add a policy for each table your apps use (**Add policy** next to the table), or switch a whole database to **Open** in the Access card on the same page. Open means any signed-in app user can read and write tables without a policy, as before. Admins and the database's owner can change this.

### App Auth sign-up is off

KilnDB allowed public sign-up unless an admin had switched it off. LambData allows it only when an admin switches it on. If sign-up was never changed on your install, it is now off and apps that let people register get HTTP 403. The **Auth** page shows that the upgrade turned it off and how many sign-ups were refused; an admin can turn it back on there. If an admin had explicitly saved sign-up as on before the upgrade, it stays on.

### Behind a reverse proxy or tunnel

The server now checks where each console request comes from. A request whose `Origin` matches the address the request was sent to is accepted, so most setups need nothing. If the console answers "Request blocked: it was sent from ..., which is not an address of this LambData server", your proxy or tunnel changes the `Host` header: add the public address (for example `https://db.example.com`) under **Network**, **Public URLs**, or set `LAMBDATA_EXTRA_ORIGINS`. See [Network access](network.md).

### Dashboard vitals

Each database has a **Show in dashboard vitals** switch on its Overview tab. Turn it off for a database you do not want in the dashboard's size chart.

## Things that changed names

| KilnDB | LambData | Old name still works |
|---|---|---|
| `KILNDB_*` environment variables | `LAMBDATA_*` | Yes. When both are set, `LAMBDATA_*` wins. |
| `~/.kilndb/config.json` (data folder pointer, outside Docker) | `~/.lambdata/config.json` | Yes, read when the new one does not exist |
| `<repo>/.kilndb` (local development data) | `<repo>/.lambdata` | Yes, used when the new one does not exist |
| `kilndb_session` cookie | `lambdata_session` | Yes, until it expires |
| `x-kilndb-function-log-id` response header | `x-lambdata-function-log-id` | Both are sent |
| `KILNDB_*` runtime variables inside functions | `LAMBDATA_*` | Both are set |
| The KilnDB image | `ghcr.io/lambdatadb/lambdata` | The KilnDB image is frozen at its last version and gets no updates |

The snapshot API (`/api/databases/:id/snapshots`) is gone; checkpoints replace it.

## Going back to KilnDB

The clean way back is the backup you made: stop LambData, put the backup in place of the data folder or volume, and start the old KilnDB image again. Everything done since the upgrade is lost.

Starting the old KilnDB image directly on the upgraded data folder works, but:

- everyone is signed out of the console, and every App Auth token is rejected, because the signing secrets are now stored encrypted and KilnDB cannot read them;
- KilnDB shows no snapshots: they became checkpoints, which KilnDB does not know about. The original snapshot files stay in `snapshots/converted/` for 30 days;
- the Data API is open again and sign-up follows KilnDB's rules.
