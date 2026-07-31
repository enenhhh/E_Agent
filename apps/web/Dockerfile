FROM node:24.4.1-alpine3.22 AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/package.json
COPY packages/app-ui/package.json packages/app-ui/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile --filter @e-agent/web...
COPY tsconfig.base.json tailwind.config.js postcss.config.js ./
COPY apps/web apps/web
COPY packages/app-ui packages/app-ui
COPY packages/contracts packages/contracts
ARG VITE_E_AGENT_API_URL=
ENV VITE_E_AGENT_API_URL=$VITE_E_AGENT_API_URL
RUN pnpm --filter @e-agent/web build

FROM nginx:1.29.0-alpine3.22
COPY apps/web/nginx-main.conf /etc/nginx/nginx.conf
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1
