FROM node:24.10-slim AS core

# Install Chromium and fonts to support major charsets (Chinese, Japanese, Arabic, Hebrew, Thai and a few others)
# Note: this installs the necessary libs to make Chromium work with Puppeteer.
# Using Chromium from Debian repos works on both AMD64 and ARM64 architectures
RUN apt-get update \
    && apt-get install -y chromium fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/bin/chromium /usr/bin/chromium-browser

# Set Chromium path for Puppeteer - use the actual binary, not the wrapper
ENV PUPPETEER_EXECUTABLE_PATH=/usr/lib/chromium/chromium

# Do not download the chromium version bundled with puppeteer
# We are using the system chromium instead
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Disable Chromium crash reporter to avoid crashpad_handler errors in Docker
ENV CHROME_DEVEL_SANDBOX=/dev/null
ENV BREAKPAD_DISABLE=1

COPY ./docker/files/usr/local/bin/entrypoint /usr/local/bin/entrypoint

# Give the "root" group the same permissions as the "root" user on /etc/passwd
# to allow a user belonging to the root group to add new users; typically the
# docker user (see entrypoint).
RUN chmod g=u /etc/passwd

# We wrap commands run in this container by the following entrypoint that
# creates a user on-the-fly with the container user ID (see USER) and root group
# ID.
ENTRYPOINT [ "/usr/local/bin/entrypoint" ]

# Un-privileged user running the application
ARG DOCKER_USER=1000
USER ${DOCKER_USER}

CMD ["chromium"]

# ---- Development image ----

FROM core AS development

CMD ["/bin/bash"]

# ---- Image to publish ----
FROM core AS dist

# Switch back to the root user to install dependencies
USER root:root

COPY . /app/
WORKDIR /app/

RUN yarn install --frozen-lockfile

ARG DOCKER_USER=1000
USER ${DOCKER_USER}

CMD ["./cli.js", "stress"]
