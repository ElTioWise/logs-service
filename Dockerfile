FROM node:22-alpine AS base
RUN npm install -g pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml ./

# ===== STAGE: Dependencies =====
FROM base AS deps
RUN pnpm install --frozen-lockfile

# ===== STAGE: Build =====
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm run build

# ===== STAGE: Production Dependencies =====
FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod

# ===== STAGE: Runtime =====
FROM node:22-alpine AS runtime
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 --ingroup nodejs --shell /bin/sh nodejs
WORKDIR /app
COPY --from=prod-deps --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=nodejs:nodejs /app/dist ./dist
COPY --from=build --chown=nodejs:nodejs /app/package.json ./
USER nodejs
EXPOSE 3000
ENV NODE_ENV=production
ENV PORT=3000
CMD ["node", "dist/index.js"]