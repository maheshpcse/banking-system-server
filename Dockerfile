FROM node:18-alpine AS deps
WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:18-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    APP_ENV=production \
    APP_PORT=3000 \
    HOST=0.0.0.0

RUN apk add --no-cache tini curl \
  && addgroup -S app && adduser -S app -G app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

RUN mkdir -p logs \
  && chown -R app:app /app

USER app
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${APP_PORT:-3000}/api/v1/health/live" || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bash", "-lc", "if [ -n \"$MONGODB_URI\" ] || [ -n \"$MONGO_URI\" ]; then echo \"Running admin seed...\"; node src/config/scripts/seed-admin.js || true; else echo \"No MongoDB URI configured; skipping admin seed.\"; fi; exec node src/index.js"]
