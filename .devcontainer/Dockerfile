# Dev image: Node 22 LTS + toolchain for native voice deps (@discordjs/opus, sodium) + ffmpeg for debugging audio.
FROM node:22-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 make g++ pkg-config libopus-dev \
      ffmpeg git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

USER node
WORKDIR /workspaces/discord-talk
