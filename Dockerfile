FROM node:22-bookworm-slim AS frontend
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY src ./src
COPY shared ./shared
COPY assets ./assets
COPY index.html vite.config.ts tsconfig.json postcss.config.js tailwind.config.js ./
RUN npm run build

FROM python:3.11-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0 fonts-dejavu-core fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir --only-binary=:all: -r requirements.txt
COPY pybackend ./pybackend
COPY shared/prompts.json ./shared/prompts.json
COPY assets/fonts ./assets/fonts
COPY --from=frontend /app/dist/public ./dist/public
RUN useradd -u 1000 -m app && chown -R app:app /app
USER app
ENV HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:3000/healthz', timeout=3)"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["uvicorn", "pybackend.app:app", "--host", "0.0.0.0", "--port", "3000", "--timeout-graceful-shutdown", "240"]
