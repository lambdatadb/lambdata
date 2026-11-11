# AI agents and scripts

LambData can be driven by AI agents (Claude Code and any other client that speaks MCP) and by plain scripts, without a browser session. They sign in with an **access token**. Every request an agent makes goes through the same checks as the HTTP API: the token's preset, its databases, its limits, ask first, undo points and the activity log.

This page uses made-up names and documentation addresses. Replace `http://192.0.2.10:4317` with the address you open the console on.

## Access tokens

An access token is a long secret that starts with `ld_`. Only an admin can create one, in the console under **Access tokens**. The secret is shown once, when the token is created; LambData keeps only a fingerprint of it. If you lose it, revoke the token and create a new one.

Each token has one of three presets. The preset cannot be changed later.

| Preset | What it is for |
|---|---|
| **Read only** | Reads databases, tables, checkpoints and jobs, and runs read-only SQL. MariaDB itself refuses any change. It can never see passwords. |
| **Builder** | Creates its own databases and manages only those: SQL that changes data, checkpoints, rollbacks, imports, syncs. Databases it did not create stay invisible to it, as if they did not exist. |
| **Admin** | Manages every database, or only the ones you pick. Destructive actions ask first by default. |

Settings on each token:

- **Databases**: limit the token to particular databases. A token limited this way cannot create new ones.
- **Allowed from**: which connections the token works on: this machine, the LAN, the tailnet, and Cloudflare. Cloudflare is off by default and has to be switched on per token.
- **See passwords**: whether the token may read database passwords and connection strings. On by default for Builder, off for Admin, impossible for Read only.
- **Ask first**: destructive actions wait for a person to approve them. Off by default for Read only and Builder, on for Admin.
- **Limits**: requests a minute (120 by default) and, for Builder, the most databases it may have at once (10 by default).
- **Expires**: an optional date after which the token stops working.

### Create one

1. Open **Access tokens** and choose **Create access token**.
2. Give it a name that says who uses it, for example `Claude Code on the build box`. The name shows in the activity log and in notifications.
3. Pick the preset and adjust the settings.
4. Copy the secret now. It is not shown again.

## Connect Claude Code

LambData's MCP endpoint is `/mcp` on the console address. Add it with the token in an `Authorization` header:

```bash
claude mcp add --transport http lambdata http://192.0.2.10:4317/mcp \
  --header "Authorization: Bearer ld_your_token_here"
```

This adds it for you in the current project (local scope). Add `--scope user` to have it in every project. Check it with `claude mcp list`, or with `/mcp` inside Claude Code.

To share the setup with a team without sharing the secret, put it in the project's `.mcp.json` and let each person set the token in their environment:

```json
{
  "mcpServers": {
    "lambdata": {
      "type": "http",
      "url": "http://192.0.2.10:4317/mcp",
      "headers": {
        "Authorization": "Bearer ${LAMBDATA_TOKEN}"
      }
    }
  }
}
```

Give each person or machine its own token, so the activity log says who did what and you can revoke one without the others.

## Other MCP clients

Any client that supports the Streamable HTTP transport works. Point it at `http://192.0.2.10:4317/mcp` and send `Authorization: Bearer ld_…` on every request.

- The endpoint is stateless and answers with JSON. It has no event stream: `GET /mcp` and `DELETE /mcp` answer 405.
- It supports MCP protocol versions 2025-11-25, 2025-06-18 and 2025-03-26.
- A console sign-in does not work here; only an access token does.
- A request sent from a web page on another site (with an `Origin` header that is not an address of this server) is refused.

## Tools

The tool list depends on the token: a Read only token is not offered tools it would be refused, and `get_connection_details` only shows up for tokens that may see passwords. Every tool takes an optional `note`: say why, in a sentence, and it shows in the token's activity. Notes may be in any language or script.

| Tool | Does |
|---|---|
| `whoami` | The token's name, preset, limits, what it can and cannot do, and whether tokens are paused |
| `list_databases` | Databases the token may see |
| `get_database` | One database: details, the address and port clients connect to, whether clients on other machines can connect, the MariaDB user, latest size and row figures. Never a password |
| `ensure_database` | Create a database, or return the one this token created earlier with that name; says which happened. A same-named database created by someone else is refused with who created it and its id |
| `delete_database` | Delete a database |
| `get_connection_details` | Host, port, user, password and connection strings. Only for tokens that may see passwords |
| `list_tables` | Tables with row counts and sizes |
| `describe_table` | Columns, indexes and foreign keys of a table |
| `run_sql` | Run one SQL statement. `max_rows` is 100 by default, at most 5,000; the result says when it was cut |
| `list_checkpoints` | Checkpoints, newest first |
| `create_checkpoint` | Save a checkpoint with a message |
| `get_changes` | What differs from the last checkpoint |
| `rollback_to_checkpoint` | Roll back to a checkpoint |
| `undo_changes` | Roll back to this token's undo point |
| `run_sync` | Start a sync of a mirror |
| `get_job` | A background job's state; `wait_seconds` (at most 50) waits for it to finish |
| `get_approval` | The state of an approval the token is waiting on |

Checkpoints, rollbacks, syncs and undo run as background jobs: the tool returns the job, and the agent follows it with `get_job`.

`get_database` says plainly when database clients on other machines cannot connect yet because outside connections are off; an admin allows them on the [Network](network.md#database-connections) page. When outside connections are on but LambData has no address it can name for you, it says to use the server's own address and gives the port.

Imports, Data API access and policies, sync settings and set-aside tables are not tools yet. Tokens can reach them through the HTTP API below.

## The HTTP API

The same token works on the management API. `GET /api/openapi.json` (with the token, or signed in to the console) describes every path a token can reach and which presets may call it. It is built from the same table the server enforces, so it never lists something that would be refused.

Errors always look like `{ "error": "…" }`, a sentence that says what went wrong.

Create a database, safely. With `"ensure": true` a retry with the same name returns the database the caller itself created earlier with that name (`"created": false`) instead of making another. If a database with that name exists but someone else created it, the answer is HTTP 409 with a message that names who created it and gives its id. It is not returned: choose another name, or ask the owner whether that database is the one to use. A Builder token cannot see databases it did not create, so for it the name is free and it gets a new database of its own. The schema name of a database created by a Builder token always ends in five random characters (for example `inventory_k3f9x`), so a name that is already taken elsewhere looks no different from one that is free.

```bash
curl -s http://192.0.2.10:4317/api/databases \
  -H "Authorization: Bearer $LAMBDATA_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-LambData-Note: database for the garden planner" \
  -d '{ "displayName": "Garden Planner", "ensure": true }'
```

Run SQL. For tokens, at most `maxRows` rows come back (500 by default, at most 5,000) and `truncated` says whether rows were cut:

```bash
curl -s http://192.0.2.10:4317/api/databases/db_0123456789abcdef/query \
  -H "Authorization: Bearer $LAMBDATA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "sql": "SELECT id, crop FROM beds ORDER BY id", "maxRows": 50 }'
```

Save a checkpoint, then follow the job it starts:

```bash
curl -s http://192.0.2.10:4317/api/databases/db_0123456789abcdef/checkpoints \
  -H "Authorization: Bearer $LAMBDATA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "message": "Before the spring import" }'

curl -s http://192.0.2.10:4317/api/jobs/job_0123456789abcdef \
  -H "Authorization: Bearer $LAMBDATA_TOKEN"
```

Roll back to a checkpoint (its id comes from `GET /api/databases/:id/checkpoints`):

```bash
curl -s -X POST http://192.0.2.10:4317/api/databases/db_0123456789abcdef/checkpoints/cp_0123456789abcdef/restore \
  -H "Authorization: Bearer $LAMBDATA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Requests with a body must be sent as JSON. Every token can read its own identity at `GET /api/access-tokens/current`. `GET /api/databases/:id` returns `connection` beside the database: `host` (null when outside connections are off or LambData cannot name a usable address), `port` and `outsideConnections`.

`X-LambData-Note` takes up to 200 characters. To send anything other than plain ASCII, percent-encode it as UTF-8 (for example with `encodeURIComponent`); LambData decodes it before it stores it.

## Ask first

With **Ask first** on, these actions wait for a person:

- deleting a database;
- rolling back to a checkpoint, including undo;
- deleting a checkpoint;
- an import that replaces the contents of a database;
- SQL whose statement starts with `DROP` or `TRUNCATE`.

The first request does nothing and answers 403 with `"code": "approval_required"` and an approval. An admin is notified and approves or declines it on **Access tokens**, **Approvals**. Then the token sends the identical request again with the header `X-LambData-Approval: <approval id>`. Identical means the same method, path and body; a different body is refused. An approval works once. A pending approval expires after 24 hours, an approved one must be used within 60 minutes. Asking again for the same pending request returns the same approval.

Through MCP the agent does not see an error: the tool says a person must approve, gives the approval id and the console address of the approvals page, and the agent calls the same tool again with `approval_id` once it is approved. `get_approval` tells it whether that happened.

Ask first does not cover every way SQL can destroy data. A `DELETE` without a `WHERE`, `ALTER TABLE … DROP COLUMN`, or a stored routine that drops something runs without asking. On a versioned database the undo point below protects against those; on a database that is not versioned nothing does. Give agents a versioned database, or a Builder token that only reaches its own databases.

## Undo points

On a [versioned](checkpoints.md#versioned-databases) database, LambData saves a checkpoint just before a token's first change through SQL, named "Before changes by" and the token's name. That is the token's undo point. Further changes reuse it until the token has made none on that database for 30 minutes; then the next change saves a new one.

The SQL result says when an undo point was saved (`undo`, with `createdNow`). `undo_changes`, or `POST /api/databases/:id/undo`, rolls the database back to it. That undoes every change since the undo point, whoever made it. The first change that saves an undo point can be the `CREATE TABLE` itself, so undoing then removes the table along with everything since that point. `GET /api/databases/:id/undo` shows the current one.

If the undo point cannot be saved, the change is refused rather than run unprotected. On a database that is not versioned there is no undo point, and the result says that a change cannot be undone.

## Limits and the pause switch

- A token over its requests-a-minute limit gets 429 with `Retry-After`. Through MCP, each message to `/mcp` counts as one request; the API calls a tool makes on the inside do not count again.
- A Builder token at its database limit cannot create another until one it created is deleted.
- **Pause** on a token stops it at once. **Pause all** on the Access tokens page stops every token, for example while you look into something. On the HTTP API a paused token can still read `GET /api/access-tokens/current` to learn that it is paused; the MCP endpoint answers every request from a paused token with 403 and says so.
- Each token's page lists what it did, with the note it sent and whether it came through the API or MCP.

## What tokens can never do

Whatever the preset: manage users, sign in or use console sessions, run setup, change settings, reach system pages such as the data folder or the audit log, change network, Tailscale or Cloudflare settings, manage notifications, storage, functions, App Auth or realtime, download checkpoints, manage access tokens, or decide approvals. Access tokens are also refused on the app-facing Data API, which uses App Auth tokens.

## Security

- **A token is a password.** Keep it in a secret store or an environment variable, never in a repository. Revoke it the moment it may have leaked.
- **Prefer the LAN or the tailnet.** Tokens work there by default. Allow Cloudflare only for a token that needs it, and only with Cloudflare Access in front.
- **Do not forward the console's port (4317) on your router.** "Local network" means any connection that reaches the console's port directly, and LambData cannot tell your home network from the internet on such a connection. With the port forwarded, every token allowed on the local network can be used from the internet. Reach LambData from outside through the tailnet or a Cloudflare Tunnel instead. If the port must be forwarded, give tokens a short expiry and keep ask first on.
- **Give the least access that does the job.** Read only for reports, Builder for an agent that builds its own databases, Admin with ask first for anything wider.
- **Results are data.** Rows, table names, checkpoint messages and MariaDB errors can contain text written by anyone. The MCP endpoint marks everything that comes out of a database as data between tags with a random value, tells the agent not to follow instructions inside it, and makes sure the content cannot close those tags early. That lowers the risk of an agent being steered by what it reads; it does not remove it. Ask first and undo points are the safety net.
- **Removing an admin revokes the tokens they created.**
