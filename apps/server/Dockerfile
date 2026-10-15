# Build context: repository root
#   docker build -f apps/server/Dockerfile -t velo-server .
FROM node:22-alpine AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY . .
RUN npm ci --ignore-scripts && npm run build -w @velo/server

# Runtime: a single bundled file, no node_modules needed.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/server/dist/server.mjs ./server.mjs
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
