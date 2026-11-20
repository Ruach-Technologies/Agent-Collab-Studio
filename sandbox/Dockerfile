# The hub's default workspace image (Node 22, npm, Python 3, Git, and make/g++ so
# packages with native code can build). Build explicitly; no host credentials or source
# are copied. The hub still enforces its runtime resource/network policy.
FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 git coreutils ca-certificates make g++ \
    && rm -rf /var/lib/apt/lists/*

USER node
WORKDIR /workspace
CMD ["sleep", "infinity"]
