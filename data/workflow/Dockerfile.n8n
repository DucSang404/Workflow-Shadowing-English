# n8n 2.x ships as a Docker Hardened Image: no apk, no package manager.
# So ffmpeg/ffprobe come in as static binaries and fonts are copied in as plain files.
FROM mwader/static-ffmpeg:7.1 AS ffmpeg

FROM alpine:3.24 AS fonts
RUN apk add --no-cache ttf-dejavu font-noto

FROM docker.n8n.io/n8nio/n8n:2.36.9

USER root
COPY --from=ffmpeg /ffmpeg  /usr/local/bin/ffmpeg
COPY --from=ffmpeg /ffprobe /usr/local/bin/ffprobe
COPY --from=fonts  /usr/share/fonts /usr/share/fonts
RUN mkdir -p /data/workflow && chown -R node:node /data/workflow
USER node
