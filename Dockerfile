FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY server.ts tsconfig.backend.json ./
COPY lib ./lib
COPY shared ./shared
COPY types ./types
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

COPY --from=build /app/dist/server.js ./dist/server.js
COPY --from=build /app/dist/lib ./dist/lib
COPY --from=build /app/dist/shared ./dist/shared
COPY --from=build /app/public/ui ./public/ui
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
CMD ["node", "dist/server.js"]
