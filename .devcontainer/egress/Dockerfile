# Smokescreen and its vendored dependencies are pinned together. No module fetches.
FROM golang:1.27.3-alpine@sha256:b8c9b82affbbb82a020bbcf998dad2ba9516944ac7e883524642a481a9505e9c AS build
ADD --checksum=sha256:2196cbbd32e4fddfd193a4a1215e4873b5ff0b902e5eecafb4fc20ddcca4d142 https://codeload.github.com/stripe/smokescreen/tar.gz/68e7b8218e226bc47d09ce705fdb8fed82145ceb /tmp/smokescreen.tar.gz
WORKDIR /src
RUN tar -xzf /tmp/smokescreen.tar.gz --strip-components=1 -C /src
# safe-chain requires an HTTP/1.1 CONNECT response before negotiating TLS.
# This one-line compatibility change is exercised by the real TLS unit test.
RUN sed -i '/case ConnectMitm:/,/tlsConfig := defaultTLSConfig/ s/HTTP\/1.0 200 OK/HTTP\/1.1 200 Connection Established/' vendor/github.com/stripe/goproxy/https.go
COPY smokescreen/ ./cmd/didcon-proxy/
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
RUN --network=none go test -mod=vendor ./cmd/didcon-proxy && go build -mod=vendor -trimpath -ldflags="-s -w" -o /didcon-proxy ./cmd/didcon-proxy
RUN mkdir /licenses && cp LICENSE.txt /licenses/smokescreen.txt && cp /usr/local/go/LICENSE /licenses/go.txt && find vendor -type f \( -iname '*license*' -o -iname '*notice*' -o -iname '*copying*' \) -exec cp --parents '{}' /licenses/ \;

FROM gcr.io/distroless/static:nonroot@sha256:18f4cc26c9ffa7f20a359298be7deadac5c607c8e03a02b8119f1a5fc2f82c99
COPY --from=build /didcon-proxy /didcon-proxy
COPY --from=build /licenses /licenses
LABEL org.opencontainers.image.source="https://github.com/stripe/smokescreen" \
      org.opencontainers.image.version="68e7b8218e226bc47d09ce705fdb8fed82145ceb"
USER 1000:1000
EXPOSE 443
ENTRYPOINT ["/didcon-proxy"]
CMD ["serve"]
