# VOIAI Backend (Not affilated with VoidAI)

## Deploying to Render

Create a Render Blueprint from this repository and deploy the resources in `render.yaml`. The Blueprint provisions the API, PostgreSQL, and Redis-compatible Key Value service. It generates `MASTER_ADMIN_KEY` and connects the managed service URLs automatically.

The container applies the Prisma schema with `prisma db push` before starting the API. Render's free PostgreSQL instance is temporary and may expire; choose a persistent database plan before storing production data.

The `/v1` API does not require an end-user account or bearer API key. It enforces 8 requests per minute per client IP. Admin endpoints still require `MASTER_ADMIN_KEY`, and upstream provider credentials are still required to execute model requests.
