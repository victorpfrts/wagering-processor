FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json mikro-orm.config.ts ./
COPY src ./src
COPY migrations ./migrations
USER bun
EXPOSE 3000
CMD ["bun", "run", "src/main.ts"]
