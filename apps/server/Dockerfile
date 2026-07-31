# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}

RUN npm install --global pnpm@11.9.0 \
  && apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY . .

RUN pnpm install --frozen-lockfile \
  && pnpm --filter @e-agent/server... build \
  && pnpm --filter @e-agent/plugin-host build \
  && pnpm --filter @e-agent/server deploy --prod --legacy /opt/e-agent

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV E_AGENT_HOST=0.0.0.0
ENV E_AGENT_PORT=4318
ENV E_AGENT_DATABASE_URL=/data/e-agent.db

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates dumb-init git \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data /opt/e-agent/apps/plugin-host/dist /opt/e-agent/plugins/code-review/prompts /opt/e-agent/plugins/builtin-skills/skills \
  && chown -R node:node /data

WORKDIR /opt/e-agent

COPY --from=builder /opt/e-agent/ ./
COPY --from=builder /workspace/apps/plugin-host/dist/ ./apps/plugin-host/dist/
COPY --from=builder /workspace/plugins/code-review/skill.json ./plugins/code-review/skill.json
COPY --from=builder /workspace/plugins/code-review/prompts/ ./plugins/code-review/prompts/
COPY --from=builder /workspace/plugins/builtin-skills/skills/ ./plugins/builtin-skills/skills/

USER node

EXPOSE 4318

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4318/health/ready').then(response=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
