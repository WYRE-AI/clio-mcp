FROM node:26-alpine AS builder
WORKDIR /app

COPY package*.json ./
# GitHub Packages auth comes in as a BuildKit secret (the release workflow
# passes --secret id=npmrc) so the token never lands in a layer or in image
# metadata. Local builds: --secret id=npmrc,src=$HOME/.npmrc
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci --ignore-scripts
COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:26-alpine
WORKDIR /app
# 0.0.0.0 is safe here only because startup refuses to listen without a real
# CONDUIT_S2S_SECRET. MCP_ALLOW_INSECURE_DEV=1 forces 127.0.0.1 even when this
# host is 0.0.0.0. AUTH_MODE=gateway never falls back to image env credentials.
ENV NODE_ENV=production AUTH_MODE=gateway MCP_HTTP_PORT=8080 MCP_HTTP_HOST=0.0.0.0 MCP_TRANSPORT=http
RUN addgroup -g 1001 -S mcp && adduser -u 1001 -S mcp -G mcp
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
LABEL org.opencontainers.image.source=https://github.com/WYRE-AI/clio-mcp
LABEL org.opencontainers.image.description="MCP server for Clio Manage -- matters, contacts, activities, communications, tasks, documents, calendar entries, and bills"
LABEL org.opencontainers.image.licenses="Apache-2.0"
USER mcp
EXPOSE 8080
CMD ["node", "dist/index.js"]
