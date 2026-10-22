# OSRSBot: dashboard + Claude agent + rs-sdk game client, in one container.
FROM oven/bun:1.3

# git for cloning rs-sdk; chromium (+ fonts) for the optional 3D browser client mode.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates chromium fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    CHROME_PATH=/usr/bin/chromium \
    DATA_DIR=/app/data \
    DASHBOARD_PORT=8080 \
    DASHBOARD_HOST=0.0.0.0

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run setup

VOLUME /app/data
EXPOSE 8080
CMD ["bun", "src/index.ts"]
