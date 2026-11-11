# Security

Baton is a self-hosted relay for trusted teams. It uses one shared secret per
deployment: anyone who holds it can claim any `userId`. Do not use it as a
public multi-tenant service.

## Reporting

Please report suspected vulnerabilities privately to the maintainers instead of
opening a public issue. Do not include real secrets, task briefs, database files,
or server addresses in a report.

## If a secret leaks

1. Generate a new secret (`openssl rand -hex 32`) on the server.
2. Update `/opt/baton/secrets/server.env` and restart `baton-server.service`.
3. Replace the local `~/.config/baton/secret` on every client and reconnect.
4. Remove the leaked value from any log, attachment, or repository history.
   Adding a `.gitignore` rule does not remove content that was already committed.

## Scope

- Shared-secret authentication is intentional; unauthorized cross-team access is
  still a vulnerability.
- Task briefs are stored server-side for seven days and included in backups.
- Per-user deletion first archives an item. After both participants confirm
  permanent deletion, its task/brief is removed from the live database; only an
  ID/expiry tombstone remains until the original expiry to prevent retry replay.
  Existing backups follow their retention period. Linked DSH sessions are not deleted.
- The server is single-process and has no account system. See `plan.md` for the
  accepted first-version limits.
