FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# --legacy-peer-deps is required because @vitest/coverage-v8 (devDep,
# pinned at ^4.1.7 by PR #26) has a peer-dep conflict with the rest
# of the lock file in strict mode. We carry coverage-v8 because the
# vitest test script optionally emits coverage output for ops.
RUN npm install --no-audit --no-fund --legacy-peer-deps

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
EXPOSE 3000
CMD ["node", "server.js"]
