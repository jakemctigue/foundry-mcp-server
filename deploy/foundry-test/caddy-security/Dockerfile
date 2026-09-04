# Deliberately preserve the reviewed runtime filesystem and Caddy release.
# This first slice repairs the embedded Go runtime, not every image finding.
FROM --platform=linux/amd64 caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648 AS runtime-base

FROM --platform=linux/amd64 caddy:2.11.4-builder-alpine@sha256:1a1689db91cfb390b2d856a1b3774e796852822cd723fa54c475b272f82bb4b7 AS builder
ENV GOTOOLCHAIN=local \
    GOMAXPROCS=1 \
    GOMEMLIMIT=512MiB \
    GOFLAGS=-p=1 \
    CGO_ENABLED=0 \
    GOPROXY=https://proxy.golang.org \
    GOSUMDB=sum.golang.org

# Comparing the old and rebuilt registries catches accidental plugin changes.
COPY --from=runtime-base /usr/bin/caddy /tmp/original-caddy
RUN set -eu; \
    test "$(go env GOVERSION)" = 'go1.26.8'; \
    xcaddy build v2.11.4 --output /usr/bin/caddy; \
    /usr/bin/caddy version | grep -E '^v2\.11\.4([[:space:]]|$)'; \
    /tmp/original-caddy list-modules > /tmp/original-modules.txt; \
    /usr/bin/caddy list-modules > /tmp/rebuilt-modules.txt; \
    diff -u /tmp/original-modules.txt /tmp/rebuilt-modules.txt; \
    go version -m /usr/bin/caddy > /tmp/go-buildinfo.txt; \
    /usr/bin/caddy list-modules --packages --versions > /tmp/module-versions.txt

FROM runtime-base AS runtime
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
COPY --from=builder /tmp/go-buildinfo.txt /usr/local/share/caddy-security/go-buildinfo.txt
COPY --from=builder /tmp/module-versions.txt /usr/local/share/caddy-security/module-versions.txt
