# Generic Next.js image for web, merchant-dashboard and admin-dashboard.
# Build with: --build-arg APP=web|merchant-dashboard|admin-dashboard
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@12.16.1 --activate
WORKDIR /repo

FROM base AS build
ARG APP=web
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/${APP} ./apps/${APP}
RUN pnpm install --frozen-lockfile --filter @wpay/${APP}...
RUN pnpm --filter @wpay/${APP}... build

FROM base AS runtime
ARG APP=web
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/${APP} ./apps/${APP}
WORKDIR /repo/apps/${APP}
USER node
EXPOSE 3000
CMD ["pnpm", "exec", "next", "start", "-p", "3000"]
