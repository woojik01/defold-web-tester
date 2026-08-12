FROM node:22-bookworm

ARG BOB_VERSION=1.12.4
ENV NODE_ENV=production
ENV PORT=3000
ENV BOB_JAR=/opt/defold/bob.jar
ENV WORK_ROOT=/tmp/defold-web-tester

RUN apt-get update \
    && apt-get install -y --no-install-recommends openjdk-25-jdk-headless curl ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

RUN mkdir -p /opt/defold \
    && curl -fL "https://github.com/defold/defold/releases/download/${BOB_VERSION}/bob.jar" -o /opt/defold/bob.jar \
    && test -s /opt/defold/bob.jar

EXPOSE 3000
CMD ["node", "server.js"]
