# Build from the repository root (the server imports the game's rules from ../src/core):
#   docker build -f server/Dockerfile -t outbreak-server .
FROM node:22-alpine AS build
WORKDIR /app
COPY server/package.json server/package-lock.json server/.npmrc server/
RUN cd server && npm ci
COPY server server
COPY src/core src/core
COPY src/net/protocol.ts src/net/codec.ts src/net/
COPY public/content public/content
RUN cd server && npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/server/dist/server.mjs ./server.mjs
COPY public/content ./content
ENV CONTENT_DIR=/app/content PORT=8787 NODE_ENV=production
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/health || exit 1
CMD ["node", "server.mjs"]
