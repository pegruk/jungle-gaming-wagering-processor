FROM oven/bun:1.4.3
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json index.ts ./
COPY src ./src
COPY scripts ./scripts
USER bun
EXPOSE 3000
CMD ["bun", "index.ts"]
