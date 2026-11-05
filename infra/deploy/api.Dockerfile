# Builds the API and the workspace packages it imports. Migrations ship in the
# image and run on startup, so a fresh database comes up ready.
FROM node:24-slim
ENV CI=true
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter "@payout-replay/api..." \
 && pnpm --filter "@payout-replay/api..." run build
WORKDIR /app/apps/api
ENV NODE_ENV=production
USER node
EXPOSE 8787
CMD ["node", "dist/server.js"]
