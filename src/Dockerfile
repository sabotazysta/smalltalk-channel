FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY server.ts ./
ENV IRC_HOST=ergo
ENV IRC_PORT=6667
ENV IRC_TLS=false
CMD ["bun", "server.ts"]
