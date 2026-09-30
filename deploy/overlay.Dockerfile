# Small production layer for the existing server image. Only the Python backend runs.
FROM telegrambot:e8aae63d1b9c844d2029d572b7f12ac63b81226a
USER root
WORKDIR /app
COPY requirements.txt ./requirements.txt
RUN /opt/weasyprint/bin/pip install --no-cache-dir --only-binary=:all: -r requirements.txt
COPY --chown=node:node pybackend ./pybackend
COPY --chown=node:node shared/prompts.json ./shared/prompts.json
COPY --chown=node:node dist/public ./dist/public
USER node
ENV PATH="/opt/weasyprint/bin:$PATH"
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:3000/healthz', timeout=3)"
CMD ["uvicorn", "pybackend.app:app", "--host", "0.0.0.0", "--port", "3000", "--timeout-graceful-shutdown", "240"]
