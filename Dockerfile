# syntax=docker/dockerfile:1
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY tsconfig.json tsconfig.build.json ./
COPY shared ./shared
COPY server ./server
RUN npm run build && npm prune --omit=dev

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY client ./client
COPY migrations ./migrations
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/ready >/dev/null || exit 1
CMD ["node", "dist/server/server.js"]
