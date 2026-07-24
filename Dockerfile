# Trove — single-image self-host. Builds the web app (with Bun), then serves it
# plus the API from the Node adapter. Configure storage/metadata/embeddings via env.
FROM node:22-slim AS build
WORKDIR /app
# The web build runs under Bun (bun build.mjs); the server runtime stays Node.
RUN npm install -g bun
COPY package.json ./
COPY packages ./packages
RUN npm install
RUN npm run build:web

FROM oven/bun:1-slim
WORKDIR /app
ENV NODE_ENV=production
# bun:sqlite is built in; no native build step needed. (Node ≥22.5's node:sqlite
# works too — swap the CMD for adapters/node.js to run under Node instead.)
COPY --from=build /app /app
ENV PORT=8787 HOST=0.0.0.0
ENV TROVE_STORAGE=filesystem TROVE_FS_ROOT=/data/objects
ENV TROVE_METADATA=sqlite TROVE_DB_PATH=/data/trove.db
VOLUME ["/data"]
EXPOSE 8787
CMD ["bun", "packages/server/src/adapters/bun.js"]
