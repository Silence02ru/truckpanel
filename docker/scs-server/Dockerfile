# syntax=docker/dockerfile:1
# Runtime + installer image for ETS2/ATS dedicated servers.
# Libraries verified on ETS2 DS 1.61 (docs/research/scs-dedicated-server.md):
#   lib32gcc-s1  SteamCMD (Valve wiki)
#   libatomic1, libx11-6  eurotrucks2_server (ldd)
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl lib32gcc-s1 libatomic1 libx11-6 tini \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 1000 scs && useradd -u 1000 -g 1000 -M -d /srv/home -s /usr/sbin/nologin scs
COPY tp-steamcmd-install tp-steamcmd-buildid /usr/local/bin/
RUN chmod 0755 /usr/local/bin/tp-steamcmd-install /usr/local/bin/tp-steamcmd-buildid
USER 1000:1000
ENTRYPOINT ["/usr/bin/tini", "--"]
