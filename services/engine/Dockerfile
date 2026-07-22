FROM python:3.12-slim

# Stockfish (GPL-3.0, unmodified official builds only).
# LICENSING: this binary stays on the server and is never shipped to clients.
# See BLUEPRINT.md Section 3.
# Debian's package is the fallback; we prefer the newest official release
# binary from the Stockfish project so paid tiers get the current engine.
RUN apt-get update \
 && apt-get install -y --no-install-recommends stockfish curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN (curl -fsSL -o /tmp/sf.tar \
      https://github.com/official-stockfish/Stockfish/releases/latest/download/stockfish-ubuntu-x86-64-avx2.tar \
  && tar -xf /tmp/sf.tar -C /tmp \
  && mv /tmp/stockfish/stockfish-ubuntu-x86-64-avx2 /usr/local/bin/stockfish \
  && chmod +x /usr/local/bin/stockfish \
  && rm -rf /tmp/sf.tar /tmp/stockfish) \
 || ln -sf /usr/games/stockfish /usr/local/bin/stockfish

ENV STOCKFISH_PATH=/usr/local/bin/stockfish
ENV PATH="/usr/games:${PATH}"

WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["python", "worker.py"]
