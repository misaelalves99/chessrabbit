# Build stage: the compiler and headers live here and never reach the runtime
# image, so a shell in a running API container has no toolchain to build with.
FROM python:3.12-slim AS builder

WORKDIR /build

RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc libpq-dev \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip wheel --no-cache-dir --wheel-dir /wheels -r requirements.txt


FROM python:3.12-slim

WORKDIR /srv

COPY --from=builder /wheels /wheels
COPY requirements.txt .
RUN pip install --no-cache-dir --no-index --find-links=/wheels -r requirements.txt \
 && rm -rf /wheels

COPY . .

# Unprivileged: this process parses attacker-supplied PGN and FEN with
# python-chess, so a compromise of it should not also be root in the container.
RUN useradd --create-home --uid 10001 chessrabbit \
 && chown -R chessrabbit:chessrabbit /srv
USER chessrabbit

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
