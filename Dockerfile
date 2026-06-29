FROM node:22-bookworm-slim

WORKDIR /app

# Install only production dependencies; the project talks to devices over LAN
# and does not need serial/Wi-SUN native build scripts for this Docker image.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev

COPY home-energy-battery-node.js server.js ./
COPY public ./public
COPY docker-entrypoint.sh ./
RUN chmod +x ./docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=8787
# Mutable config, schedules, and history are mounted here so image rebuilds do
# not erase a user's local device addresses or recorded readings.
ENV DATA_DIR=/data
ENV TZ=UTC

# Run as the unprivileged "node" user shipped by the base image. /data is
# created and owned by that user so a named volume mounted there inherits
# writable ownership on first use.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8787/tcp
EXPOSE 3610/udp

# Liveness probe hits the side-effect-free /healthz endpoint using Node's
# built-in fetch, so the image needs no extra tools like curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
