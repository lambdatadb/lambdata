# Security policy

## Supported versions

LambData is pre-1.0. Security fixes go into the latest version on the default branch and the `latest` image. The KilnDB image is frozen at its last version and gets no fixes; see [Upgrading from KilnDB](docs/upgrading.md).

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting for this repository (the **Security** tab, **Report a vulnerability**). Include a clear description, the affected component, steps to reproduce or a proof of concept, the likely impact, and any suggested fix.

Please do not access data that is not yours, disrupt services, or publish details before a fix is available. Reports are acknowledged as soon as practical, and coordinated disclosure is appreciated.

## Secrets and sensitive data

When sharing logs or diagnostics, remove:

- console session cookies and App Auth tokens
- database user names, passwords and connection strings
- the first-run setup token, Tailscale auth keys, Cloudflare tunnel tokens and private host names
- notification addresses (Discord, Slack and webhook URLs, ntfy topics and tokens) and webhook signing secrets
- the `master.key` file
- database dumps, downloaded checkpoints and uploaded files

`master.key` is part of a backup and must never be committed to source control. It encrypts database passwords, sync source passwords, function secrets, the Cloudflare tunnel token, notification destination settings and the session signing secrets.

## First-run setup

Until the first admin account exists, setup is protected by a one-time setup token. LambData prints it in its log at every start while setup is unfinished, on the line `LambData first-run setup token:` (Docker: `docker logs <container>`; Unraid: click the container's icon on the Docker tab and choose **Logs**). Restarting before setup is done prints a new token and the old one stops working. Only a hash of the token is kept in memory, and it is discarded when setup completes.

- Every setup step that changes something (choosing the data folder, checking a folder, creating the admin) needs the token, except for requests made on the server itself with no proxy in between. A request from the server itself whose `Host`, `Origin` or `Referer` names another host is treated as coming from the local network and needs the token too. Behind a forwarder on the same machine, set `LAMBDATA_TRUST_LOOPBACK=0` so that no connection is exempt (see [Network access](docs/network.md#a-forwarder-on-the-same-machine)).
- Ten wrong tokens from the same address within 15 minutes block that address for a while.
- The native folder picker only works from the server itself before setup.
- Pointing setup at a folder that already holds a LambData or KilnDB install adopts that install as it is; it is never overwritten. A folder that is not empty and holds no install is refused.
- After setup these endpoints need an admin session, and `/api/setup/state` no longer reports file-system paths.

Even with the token, finish setup before the console is reachable from anywhere you do not trust.

## Roles

| Role | What it can do |
|---|---|
| `admin` | Everything: every database, console users, App Auth, Network, functions (including their source, logs and secrets), settings and limits. |
| `db_owner` | Create databases and storage buckets, and fully manage the ones they own: settings, checkpoints, rollbacks, imports, Data API access and policies, deletion. They do not see other owners' databases. |
| `viewer` | Read-only everywhere. Viewers see every database, its history and metrics, and can download checkpoints, so they can read all data. Their SQL editor runs through a separate read-only MariaDB account and accepts read statements only. |

Changing your own password requires the current one and signs out your other sessions. An admin resetting a console or App Auth user's password signs that user out everywhere. `POST /api/auth/logout-all` signs the caller out everywhere. The console session cookie is HTTP-only and `SameSite=Strict`, and gets the `Secure` flag whenever the console is used over HTTPS.

## Requests from other sites

Console requests that change something must be sent as JSON (uploads use their own headers), and when they carry a session cookie their `Origin` must be an address of this server: the address the request was sent to, a public URL listed on the Network page, or `LAMBDATA_EXTRA_ORIGINS`. Behind a proxy that rewrites the `Host` header, list the public address under **Network**, **Public URLs**. App-facing APIs (Data API, App Auth, functions, Realtime) use bearer tokens and are not subject to this check. Browsers still apply their own cross-origin rules: a web page served from another address that calls these APIs needs that address listed under Public URLs or in `LAMBDATA_EXTRA_ORIGINS`. Servers, scripts and game servers are not affected.

Who may reach the console at all (LAN, tailnet, Cloudflare) is set on the Network page; see [Network access](docs/network.md).

## Data API, App Auth and Realtime

- The Data API is closed by default. A table without a Data API policy refuses select, insert, update and delete to every App Auth user unless an admin or the database's owner opens that database on the Data API page. Each refusal caused by a missing policy is counted per database, table and operation and shown on the Data API page.
- Public App Auth sign-up is off unless an admin turns it on.
- Realtime subscriptions to database-change channels (`db:<database>` and `db:<database>:table:<table>`) follow the same rules as Data API reads. When a policy has an owner column, change events reach only the owner of the rows. App users cannot broadcast or set presence on `db:` channels.
- Data API policies apply to requests through LambData only. Applications that connect to MariaDB directly are governed by MariaDB's own grants.

## Functions are trusted code, not a sandbox

A function runs as a Bun subprocess under the same operating-system user as the API. It can read every file the API can read, including `master.key`, `metadata.sqlite` and other functions' source, and it can open network connections, including to MariaDB. Treat writing a function like giving shell access to the server.

- Only admins can create a function, change its source or settings (including turning off token verification), delete it, read its source or invocation logs, or manage function secrets. Other roles can see the list of functions.
- The subprocess does not inherit the API's environment. It receives `PATH`, `HOME`, `TMPDIR`, `TZ`, `LANG`, `LANGUAGE`, `LC_*`, `NODE_ENV`, the proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY` and their lowercase forms) and `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS` when the API has them set, plus the function secrets and the `LAMBDATA_*` / `KILNDB_*` runtime variables. A value a function used to read from the container environment must be stored as a function secret.
- Each invocation runs in its own process group with the function's folder as its working directory. After 60 seconds the whole group is killed, and anything a function leaves running is killed when it returns.
- At most `LAMBDATA_FUNCTIONS_MAX_CONCURRENT` invocations (default 8) run at once, with up to four times that many waiting briefly; beyond that callers get HTTP 503 with `Retry-After`. Request bodies are limited to 10 MB and output to 64 MB.

These limits contain mistakes and runaways. They do not stop a malicious function.

## Notifications

Only admins can see or change notification destinations. A destination's address, signing secret, ntfy token and custom header values are stored encrypted with `master.key` and are never returned by the API or written to logs, audit entries or delivery records; the console shows only a masked address. Outbound requests do not follow redirects and refuse link-local, cloud metadata, unspecified, multicast and reserved addresses, and LambData's own API port, both when a destination is saved and again before every send. Messages carry names, short hashes, counts and display names, never row data, credentials, connection strings, tokens or email addresses. See [Notifications](docs/notifications.md).

## Storage objects

Objects are served from the console's own address, so they are never treated as pages: every object response carries `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`. Only PNG, JPEG, GIF, WebP, AVIF, BMP and ICO images and plain text are shown inline (public URLs, or console downloads with `?inline=1`); everything else, including HTML, SVG and PDF, is sent as a download. `?download=1` forces a download on a public URL. Embedding a public object in another page with `<img>`, `<video>` or `fetch` is unaffected.

## Limits

LambData keeps a floor of free space on the data volume so MariaDB can keep running. Below it, new uploads, files in Storage, checkpoints, rollbacks, imports, mirror syncs and Data API inserts and updates are refused with a message giving the free space and the floor (the Data API checks at most once every 10 seconds; its reads and deletes are not checked); automatic checkpoints and syncs skip that round and log it at most once an hour. Below the warning level, LambData logs a warning (at most once an hour) and adds one to new checkpoint, rollback and sync jobs.

| Variable | Default | Meaning |
|---|---|---|
| `LAMBDATA_DISK_FLOOR` | 10% of the data volume, at most 5 GB | Free space LambData keeps. A size such as `5GB`, `500MB`, or `0` to turn the floor off. |
| `LAMBDATA_DISK_WARN` | twice the floor | Free space below which LambData warns. |
| `LAMBDATA_IMPORT_MAX_BYTES` | 2 GB | Largest file accepted for an import. |
| `LAMBDATA_IMPORT_MAX_PENDING_UPLOADS` | 5 | Uploads one user may have waiting to be imported. Unused uploads are deleted after 24 hours. |
| `LAMBDATA_IMPORT_MAX_PENDING_BYTES` | twice the largest file | Total size of one user's waiting uploads. |
| `LAMBDATA_CHECKPOINT_MAX_RETENTION` | 30 | Most automatic checkpoints of each kind a database owner may keep per database. |
| `LAMBDATA_CHECKPOINT_MIN_INTERVAL_HOURS` | 1 | Shortest interval a database owner may set between automatic checkpoints. |
| `LAMBDATA_FUNCTIONS_MAX_CONCURRENT` | 8 | Function invocations running at once. |
| `LAMBDATA_MAX_CONCURRENT_JOBS` | 3 | Background jobs (checkpoints, rollbacks, syncs, imports) running at once. |
| `LAMBDATA_FENCE_MAX_MINUTES` | 120 | Longest a rollback, replacing import or sync may keep a database closed to its own account before it is stopped and the database opened again. |

Sizes accept `B`, `KB`, `MB`, `GB` and `TB` (all powers of 1024). An invalid value is logged and the default is used.

The two checkpoint ceilings can also be set by an admin under **Settings**; a value saved there wins over the variable. Admins themselves are not bound by them.

Fixed limits: a file in Storage can be at most 250 MB, and other API request bodies at most 10 MB.

Not covered by the floor: SQL run in the console's **Query** tab, and applications that connect to MariaDB directly, can still fill the disk.
