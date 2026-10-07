# Custom Caddy with the DNS-01 providers we support. Kept in its own stage so
# the Node build does not need a Go toolchain.
FROM caddy:2-builder AS caddy
RUN xcaddy build --output /usr/bin/caddy \
    --with github.com/caddy-dns/cloudflare \
    --with github.com/caddy-dns/route53

FROM node:24-bookworm-slim AS build

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

FROM node:24-bookworm-slim

WORKDIR /app

# Install only production dependencies; the project talks to devices over LAN
# and does not need serial/Wi-SUN native build scripts for this Docker image.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev
# Caddy validates ACME and DNS-provider TLS against the system trust store.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Caddy terminates TLS for the trusted hostname and forwards to the app on an
# internal loopback port. The app runs behind it (HOST=127.0.0.1).
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy

COPY --from=build /app/dist/server.js ./dist/server.js
COPY --from=build /app/dist/lib ./dist/lib
COPY --from=build /app/dist/shared ./dist/shared
COPY --from=build /app/public/ui ./public/ui
COPY docker-entrypoint.sh ./
RUN chmod +x ./docker-entrypoint.sh

ENV NODE_ENV=production
ENV HOST=127.0.0.1
ENV PORT=8787
ENV HTTPS_PORT=443
ENV XDG_DATA_HOME=/data/caddy
ENV XDG_CONFIG_HOME=/data/caddy
# Mutable config, schedules, and history are mounted here so image rebuilds do
# not erase a user's local device addresses or recorded readings.
ENV DATA_DIR=/data
ENV TZ=UTC

EXPOSE 8787/tcp
EXPOSE 443/tcp
EXPOSE 3610/udp

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
