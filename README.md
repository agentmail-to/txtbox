# txt.box

Cloud-synced text editor with conflict-free realtime collaboration.

- **Frontend**: Vite + vanilla TypeScript, plain `<textarea>`, Yjs CRDT
- **Backend**: Cloudflare Workers (api-session + snapshotter)
- **Storage**: S2 streams (one per doc) + R2 snapshots
- **Infra**: Pulumi (Cloudflare provider)

## Prerequisites

- Node.js >= 20
- pnpm
- Pulumi CLI
- Wrangler CLI (>= 4.36.0)
- S2 account with separate dev/prod basins + access tokens
- Cloudflare account with `txt.box` and `txtbox.dev` domains

## Setup

```bash
pnpm install
```

## Environments

Dev and prod are fully isolated -- separate worker scripts, R2 buckets, S2 basins, and domains.

| Resource | Dev | Prod |
|---|---|---|
| API worker | `txtbox-api-session-dev` | `txtbox-api-session-prod` |
| Snapshotter | `txtbox-snapshotter-dev` | `txtbox-snapshotter-prod` |
| R2 bucket | `txtbox-snapshots-dev` | `txtbox-snapshots-prod` |
| Domain | `txtbox.dev` | `txt.box` |
| API domain | `api.txtbox.dev` | `api.txt.box` |
| Snapshots domain | `snapshots.txtbox.dev` | `snapshots.txt.box` |
| S2 basin | separate | separate |

## Configuration

All config is managed through Pulumi (single source of truth). Each stack has its own config:

```bash
cd infra

# Dev stack
pulumi stack init dev
pulumi config set account_id "YOUR_CLOUDFLARE_ACCOUNT_ID"
pulumi config set zone_id "ZONE_ID_FOR_TXTBOX_DEV"
pulumi config set domain "txtbox.dev"
pulumi config set s2_endpoint "https://txtbox-dev.b.aws.s2.dev"
pulumi config set --secret s2_access_token "s2_..."
pulumi config set --secret cloudflare:apiToken "YOUR_CF_API_TOKEN"

# Prod stack
pulumi stack init prod
pulumi config set account_id "YOUR_CLOUDFLARE_ACCOUNT_ID"
pulumi config set zone_id "ZONE_ID_FOR_TXT_BOX"
pulumi config set domain "txt.box"
pulumi config set s2_endpoint "https://txtbox-prod.b.aws.s2.dev"
pulumi config set --secret s2_access_token "s2_..."
pulumi config set --secret cloudflare:apiToken "YOUR_CF_API_TOKEN"
```

For local development, copy the `.dev.vars.example` files:

```bash
cp workers/api-session/.dev.vars.example workers/api-session/.dev.vars
cp workers/snapshotter/.dev.vars.example workers/snapshotter/.dev.vars
# Then edit .dev.vars with your actual values
```

## Development

```bash
# Frontend (uses http://localhost:8787 in dev)
pnpm dev

# Workers (each in its own terminal)
cd workers/api-session && pnpm dev
cd workers/snapshotter && pnpm dev
```

## Deploy

```bash
# Dev
cd workers/api-session && pnpm deploy:dev
cd workers/snapshotter && pnpm deploy:dev
cd infra && pulumi stack select dev && pulumi up

# Prod
cd workers/api-session && pnpm deploy:prod
cd workers/snapshotter && pnpm deploy:prod
cd infra && pulumi stack select prod && pulumi up
```

Workers must be deployed before `pulumi up` (Pulumi pushes secrets to existing scripts).

## Architecture

- Every URL path on `txt.box` is a document: `txt.box/<docId>`
- API lives on `api.txt.box/session` (single endpoint)
- Each doc is an S2 stream (`doc:<docId>`) with Yjs update records
- Snapshots are periodically written to R2 for fast load times
