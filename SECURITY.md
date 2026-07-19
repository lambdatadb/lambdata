# Security policy

## Supported versions

KilnDB is currently pre-1.0. Security fixes are applied to the latest version on the default branch.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting feature for this repository. Include a clear description, affected component, reproduction steps or proof of concept, likely impact, and any suggested mitigation.

Please avoid accessing data that is not yours, disrupting services, or publishing details before a fix is available. Reports will be acknowledged as soon as practical and coordinated disclosure is appreciated.

## Secrets and sensitive data

When sharing logs or diagnostics, remove:

- console session cookies and App Auth tokens
- database usernames, passwords, and connection strings
- Tailscale auth keys and private hostnames
- the KilnDB `master.key`
- database dumps and uploaded object contents

The `master.key` is part of an installation's backup and must never be committed to source control.
