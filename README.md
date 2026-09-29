# TelegramBot

Pushes to `main` deploy the tracked repository files to `root@46.8.231.179` after deployment is enabled.

## Deployment setup

In this repository's **Settings → Secrets and variables → Actions**, configure:

| Type | Name | Value |
| --- | --- | --- |
| Secret | `DEPLOY_SSH_KEY` | A dedicated deployment SSH private key; install its public key in the server's `/root/.ssh/authorized_keys`. |
| Secret | `DEPLOY_KNOWN_HOSTS` | The server's SSH known-hosts entry, with its fingerprint verified through a trusted server console. |
| Variable | `DEPLOY_PORT` | SSH port; defaults to `22`. |
| Variable | `DEPLOY_ENABLED` | Set to `true` after server access and both secrets are configured. |

The server must allow SSH from the GitHub runner and have `tar` and GNU `mv` installed. The workflow can also be run manually from the Actions tab.

Once enabled, a schedule checks the latest `main` every 15 minutes, so an outage does not require another push to retry deployment. GitHub may delay scheduled runs. Checks skip uploading when that commit is already deployed. Scheduled workflows in public repositories may be disabled after 60 days without repository activity.

Each deployment uploads a complete code snapshot to `/opt/telegrambot/releases/<commit>`. Only after successful upload does `/opt/telegrambot/current` switch to that snapshot. Previous releases are retained. Reserve these paths for this workflow.

Keep bot tokens, runtime data, and server environment files outside release directories, for example in `/opt/telegrambot/shared`. Only tracked Git files are uploaded.

The project is currently empty: this workflow publishes code only. Dependency installation and bot startup/restart must be added when the application and its runtime are defined.
