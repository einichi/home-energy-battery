# Caddy is cross-compiled natively for the target architecture on the build
# platform, so a multi-architecture build never runs the Go toolchain under
# emulation.
FROM --platform=$BUILDPLATFORM caddy:2-builder AS caddy
ARG TARGETOS TARGETARCH
RUN GOOS=$TARGETOS GOARCH=$TARGETARCH CGO_ENABLED=0 \
    xcaddy build --output /usr/bin/caddy \
    --with github.com/caddy-dns/cloudflare \
    --with github.com/caddy-dns/route53

# The TypeScript/React build produces architecture-independent output, so it
# runs once on the build platform and is shared across target architectures.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY server.ts tsconfig.backend.json ./
COPY lib ./lib
COPY shared ./shared
COPY types ./types
COPY scripts/clean-build.mjs ./scripts/clean-build.mjs
COPY tests/support ./tests/support
COPY frontend ./frontend
COPY eslint.config.js ./
RUN npm run build:server
RUN npm run build:ui
RUN find dist public/ui -name '*.map' -delete

# Production dependencies are pure JavaScript (installed with --ignore-scripts),
# and the CA bundle is architecture-independent data. Building both once here
# keeps the per-architecture image copy-only.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS deps

WORKDIR /app

# Caddy validates ACME and DNS-provider TLS against the system trust store.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev

# Final per-architecture image. It only copies artifacts, so no target-arch
# instruction is emulated.
FROM node:24-bookworm-slim

WORKDIR /app

# package.json is required at runtime so Node treats dist/**/*.js as ESM.
COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

# Caddy terminates TLS for the trusted hostname and forwards to the app on an
# internal loopback port. The app runs behind it (HOST=127.0.0.1).
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy

COPY --from=build /app/dist/server.js ./dist/server.js
COPY --from=build /app/dist/lib ./dist/lib
COPY --from=build /app/dist/shared ./dist/shared
COPY --from=build /app/public/ui ./public/ui
COPY docker-entrypoint.sh ./

ENV NODE_ENV=production
ENV HOST=127.0.0.1
ENV PORT=8787
ENV HTTPS_PORT=443
# Mutable config, schedules, and history are mounted here so image rebuilds do
# not erase a user's local device addresses or recorded readings. Caddy state
# lives under DATA_DIR/caddy and is derived by the entrypoint.
ENV DATA_DIR=/data
ENV TZ=UTC

EXPOSE 8787/tcp
EXPOSE 443/tcp
EXPOSE 3610/udp

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
