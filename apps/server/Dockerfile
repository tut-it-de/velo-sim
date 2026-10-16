# Build context: repository root
#   docker build -f apps/server/Dockerfile -t velo-server .
# The image contains the game server and the web client (served on / of the same port).
FROM node:22-alpine AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY . .
RUN npm ci --ignore-scripts \
 && npm run build -w @velo/server \
 && npm run build -w @velo/client

# Runtime: the bundled server plus the static client build, no node_modules needed.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    CLIENT_DIST=/app/public
COPY --from=build /app/apps/server/dist/server.mjs ./server.mjs
COPY --from=build /app/apps/client/dist ./public
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
