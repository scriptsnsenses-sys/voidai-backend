FROM oven/bun:1.2-alpine AS deps

WORKDIR /app

COPY bun.lock package.json ./
COPY prisma ./prisma

RUN apk add --no-cache openssl && \
    bun install --frozen-lockfile && \
    DATABASE_URL=postgresql://build:build@localhost:5432/build bunx prisma generate

FROM oven/bun:1.2-alpine AS runner

WORKDIR /app

RUN addgroup -g 1001 bunuser && \
    adduser -D -u 1001 -G bunuser bunuser && \
    apk add --no-cache openssl

COPY --from=deps --chown=bunuser:bunuser /app/node_modules ./node_modules
COPY --chown=bunuser:bunuser src ./src
COPY --chown=bunuser:bunuser prisma ./prisma
COPY --chown=bunuser:bunuser package.json ./

RUN mkdir -p logs && \
    chown bunuser:bunuser logs

USER bunuser

EXPOSE 8080

ENV NODE_ENV=production
CMD ["sh", "-c", "bunx prisma db push --skip-generate && exec bun run src/index.ts"]