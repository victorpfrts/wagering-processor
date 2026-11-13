FROM oven/bun:1-alpine
WORKDIR /app

# Dependências primeiro: a camada só é refeita quando o lockfile muda.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json mikro-orm.config.ts ./
COPY migrations ./migrations
COPY src ./src

USER bun
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -qO- http://localhost:3000/health/live || exit 1

# Forma exec: o bun é o PID 1 e recebe o SIGTERM do `docker stop` direto.
CMD ["bun", "src/main.ts"]
