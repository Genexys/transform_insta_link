FROM node:26.13.1-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp from PyPI, pinned: the distro/Nix packages lag months behind, and
# YouTube/TikTok break old releases.
RUN python3 -m venv /opt/ytdlp
COPY requirements-ytdlp.txt /opt/ytdlp/
RUN /opt/ytdlp/bin/pip install --no-cache-dir -r /opt/ytdlp/requirements-ytdlp.txt
ENV PATH=/opt/ytdlp/bin:$PATH

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# The compiled .js files are committed (CI checks they match the .ts).
COPY . .

CMD ["npm", "run", "railway:start"]
