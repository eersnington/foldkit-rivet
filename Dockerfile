# Build with: docker build --platform linux/amd64 -t effect-foldkit-demo:local .
FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml rivetkit-effect-pr1800.tgz ./

# Builds the Effect UI frontend to web/dist. `@effect/ui` comes from pkg.pr.new,
# so this install needs network access.
FROM base AS web
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY shared shared
# The page shows the server source, so the web build reads these files.
COPY server server
COPY web web
RUN pnpm build

FROM base
# A runner never starts an engine or Rivet Services, so drop their binaries.
RUN pnpm install --prod --frozen-lockfile \
	&& rm -rf node_modules/.pnpm/@rivetkit+engine-cli-* node_modules/.pnpm/@rivet-dev+services-* \
		node_modules/.pnpm/@rivet-dev+agentos-* node_modules/.pnpm/@rivet-dev+agent-os-* node_modules/.pnpm/@agentos-software* \
	&& rm -rf /root/.local/share/pnpm /root/.cache
COPY shared shared
COPY server server
COPY --from=web /app/web/dist web/dist
ENV NODE_ENV=production
# Node runs the TypeScript sources directly (type stripping).
CMD ["node", "server/main.ts"]
