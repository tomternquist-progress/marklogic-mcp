# ── Stage 1: compile the thin HTTP wrapper ────────────────────────────────────
FROM eclipse-temurin:21-jdk-jammy AS builder

WORKDIR /build
COPY FluxServer.java .
RUN javac FluxServer.java

# ── Stage 2: runtime image ────────────────────────────────────────────────────
# Eclipse Temurin JRE on Ubuntu Jammy — glibc-based so Spark/Flux JARs run well.
FROM eclipse-temurin:21-jre-jammy

# Install curl + unzip (needed to download Flux) then clean up
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip \
    && rm -rf /var/lib/apt/lists/*

# Download and install MarkLogic Flux
# Check https://github.com/marklogic/flux/releases for the latest version.
ARG FLUX_VERSION=2.0.0
RUN curl -fsSL \
      "https://github.com/marklogic/flux/releases/download/${FLUX_VERSION}/marklogic-flux-${FLUX_VERSION}.zip" \
      -o /tmp/flux.zip \
    && unzip -q /tmp/flux.zip -d /opt \
    && mv /opt/marklogic-flux-${FLUX_VERSION} /flux \
    && chmod +x /flux/bin/flux \
    && rm /tmp/flux.zip

# Copy all compiled class files (including inner classes like FluxServer$RunHandler.class)
WORKDIR /app
COPY --from=builder /build/*.class .

# Bundle sample data for testing; user data should be mounted at /data
COPY --chown=root:root sample-data/ /test-data/

# Port the HTTP wrapper listens on
EXPOSE 8080

# Env tunables
ENV FLUX_PORT=8080 \
    FLUX_TIMEOUT_MINUTES=30

HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
    CMD curl -sf http://localhost:8080/health || exit 1

ENTRYPOINT ["java", "-cp", "/app", "FluxServer"]
