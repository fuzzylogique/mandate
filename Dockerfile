# One container for the hosted demo: dashboard, API, demo vendors and facilitator.
# Deployed to Fly.io (see fly.toml); secrets come from `fly secrets`, never the image.
FROM node:26-slim

RUN npm install -g pnpm@12.18.0
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/agent/package.json apps/agent/
COPY apps/facilitator/package.json apps/facilitator/
COPY apps/merchant/package.json apps/merchant/
COPY apps/receipts/package.json apps/receipts/
COPY apps/web/package.json apps/web/
COPY packages/langchain/package.json packages/langchain/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @mandate/web build

ENV NODE_ENV=production
EXPOSE 8080 4021 4023
CMD ["bash", "scripts/fly-start.sh"]
