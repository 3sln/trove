# Trove — single-image self-host. Builds the web app, then serves it plus the API
# from the Node adapter. Configure storage/metadata/embeddings via env (see README).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json ./
COPY packages ./packages
RUN npm install
RUN npm run build:web

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
# node:sqlite is built in; no native build step needed.
COPY --from=build /app /app
ENV PORT=8787 HOST=0.0.0.0
ENV TROVE_STORAGE=filesystem TROVE_FS_ROOT=/data/objects
ENV TROVE_METADATA=sqlite TROVE_DB_PATH=/data/trove.db
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "packages/server/src/adapters/node.js"]
