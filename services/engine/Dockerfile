FROM python:3.12-slim

# Stockfish from Debian repos (GPL-3.0, unmodified official build).
# LICENSING: this binary stays on the server and is never shipped to clients.
# See BLUEPRINT.md Section 3.
RUN apt-get update \
 && apt-get install -y --no-install-recommends stockfish \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["python", "worker.py"]
