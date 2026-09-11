# Telegram Builder Bot Backend

This service runs the GitHub repository creation and Vercel deployment work
that is too slow or restricted for TeleBotHost TBL commands.

## What it does

- Creates a target GitHub repository and mirrors the private source repository
  into it. It does not depend on GitHub's cross-account private-fork policy.
- Reads `config.txt`, applies user configuration updates, and commits them.
- Starts and monitors the Vercel production deployment.
- Publishes its current public URL to `backend-endpoint.json` in this
  repository at startup. The TeleBotHost command reads that discovery file, so
  changing Railway or another host does not require changing a hardcoded URL.

## Required variables

Set these in Railway or another host:

- `BUILDER_BACKEND_API_KEY`
- `BUILDER_GITHUB_SOURCE_TOKEN`
- `BUILDER_GITHUB_TARGET_TOKEN`
- `BUILDER_SOURCE_REPO`
- `BUILDER_SOURCE_BRANCH`
- `BUILDER_VERCEL_TOKEN`

Optional:

- `BUILDER_VERCEL_TEAM_ID`
- `BUILDER_VERCEL_PROJECT_ID`
- `BACKEND_PUBLIC_URL` — only needed when the host does not expose a public
  domain variable. Railway is detected automatically through
  `RAILWAY_PUBLIC_DOMAIN`.

The target GitHub token needs repository-create and contents-write permission.
The source token needs read access to the private source repository.

## Railway

From this directory, after authenticating the Railway CLI:

```bash
railway login
railway link
railway variables set BUILDER_BACKEND_API_KEY='...'
railway variables set BUILDER_GITHUB_SOURCE_TOKEN='...'
railway variables set BUILDER_GITHUB_TARGET_TOKEN='...'
railway variables set BUILDER_SOURCE_REPO='instaboosterwesd/rgxpanel.in'
railway variables set BUILDER_SOURCE_BRANCH='main'
railway variables set BUILDER_VERCEL_TOKEN='...'
railway up
```

Do not commit a `.env` file or paste credentials into Telegram. The service
only prints status and error messages, never secret values.