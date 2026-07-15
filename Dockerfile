FROM node:24-bookworm-slim

WORKDIR /app

# Install only production dependencies; the project talks to devices over LAN
# and does not need serial/Wi-SUN native build scripts for this Docker image.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev

COPY home-energy-battery-node.js server.js ./
COPY lib ./lib
COPY public ./public
COPY docker-entrypoint.sh ./
RUN chmod +x ./docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=8787
# Mutable config, schedules, and history are mounted here so image rebuilds do
# not erase a user's local device addresses or recorded readings.
ENV DATA_DIR=/data
ENV TZ=UTC

EXPOSE 8787/tcp
EXPOSE 3610/udp

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
