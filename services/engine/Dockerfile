FROM python:3.12-slim-bookworm

# Debian selects a Stockfish build for the container's CPU architecture.
RUN apt-get update \
 && apt-get install -y --no-install-recommends stockfish ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV STOCKFISH_PATH=/usr/games/stockfish
ENV PATH="/usr/games:${PATH}"
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN useradd --create-home --uid 10001 chessrabbit
USER chessrabbit
CMD ["python", "worker.py"]
