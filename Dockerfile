FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Download DHF client JAR — bundled for dhf_flow_run_jar (large-scale flow execution without eval)
# Override DHF_VERSION at build time: docker build --build-arg DHF_VERSION=5.8.2 ...
ARG DHF_VERSION=5.8.1
RUN apk add --no-cache curl && \
    curl -fsSL -o /app/marklogic-data-hub-client.jar \
    "https://github.com/Marklogic-retired/marklogic-data-hub/releases/download/v${DHF_VERSION}/marklogic-data-hub-${DHF_VERSION}-client.jar"

FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/marklogic-data-hub-client.jar ./marklogic-data-hub-client.jar

# Java JRE required to run the DHF client JAR
RUN apk add --no-cache openjdk21-jre-headless

ARG GIT_COMMIT=unknown
ARG BUILD_TIME=unknown
ENV GIT_COMMIT=${GIT_COMMIT}
ENV BUILD_TIME=${BUILD_TIME}
# Pre-configured JAR path — override with ML_DHF_CLIENT_JAR if you place the JAR elsewhere
ENV ML_DHF_CLIENT_JAR=/app/marklogic-data-hub-client.jar

EXPOSE 3000
ENTRYPOINT ["node", "dist/index.js"]
