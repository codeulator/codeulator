FROM node:18.18 as base

# Install required apt packages
RUN apt update && apt install -y build-essential g++ libx11-dev libxkbfile-dev libsecret-1-dev python-is-python3 python3-pip python3-setuptools

# Install pnpm and node-gyp
RUN npm i -g pnpm node-gyp

# Install vscode dependencies (so we can use vscode-automation)
ARG tag=1.79.0
RUN curl -qOJL https://github.com/microsoft/vscode/archive/refs/tags/${tag}.zip
RUN unzip vscode-${tag}.zip
RUN mv vscode-${tag} /vscode
RUN cd /vscode && git init && yarn
RUN cd /vscode/test/automation && npm run compile

# Copy jsdiff
COPY jsdiff /app/jsdiff

# Delete some large files that are not needed
RUN rm -rf vscode-${tag}.zip $HOME/.cache

# -----------
# Build the server
FROM base as build-server

# Copy the package.json and lock files
COPY server/package*.json server/pnpm-lock.yaml /app/server/

# Install the npm packages
WORKDIR /app/server
RUN pnpm i --frozen-lockfile

# Copy the TypeScript source files
COPY server/src ./src

# Compile the TypeScript files
COPY server/tsconfig.json ./
RUN pnpm run build

# ---------
# Build the extension
FROM base as build-fsproxy

# Install vsce
RUN npm i -g @vscode/vsce

# Build the extension as a vsix file
WORKDIR /app/fsproxy
COPY fsproxy .
RUN npm i --frozen-lockfile
RUN vsce package -t linux-x64 --no-git-tag-version 0.0.1 --pre-release --allow-missing-repository

# ---------
# Build sf_search
FROM base as build-search

# Build safetensors wheel (needed for sf_search)
WORKDIR /app/search
RUN curl https://sh.rustup.rs -sSf | sh -s -- -y
RUN . $HOME/.cargo/env && pip --no-cache-dir wheel safetensors

# Build the sf_search wheel
COPY search .
RUN python setup.py sdist bdist_wheel

# ---------
# Run stage
FROM base

# Install the required dependencies
RUN apt update && apt install -y curl apt-transport-https gnupg wget
RUN wget -qO- https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor > packages.microsoft.gpg
RUN install -D -o root -g root -m 644 packages.microsoft.gpg /etc/apt/keyrings/packages.microsoft.gpg
RUN sh -c 'echo "deb [arch=amd64,arm64,armhf signed-by=/etc/apt/keyrings/packages.microsoft.gpg] https://packages.microsoft.com/repos/code stable main" > /etc/apt/sources.list.d/vscode.list'
RUN apt update && apt install -y code x11vnc xvfb fluxbox && apt clean

# Install sf_search (and delete the wheel files to reduce image size)
COPY --from=build-search /app/search/dist/sf_search-*.whl /app/search/safetensors-*.whl ./
RUN python -m venv --system-site-packages --without-pip /app/venv
ENV PATH="/app/venv/bin:$PATH"
RUN python -m pip --no-cache-dir install ./safetensors-*.whl ./sf_search-*.whl
RUN rm ./safetensors-*.whl ./sf_search-*.whl

# Copy the package.json and lock files
WORKDIR /app/server
COPY server/package*.json server/pnpm-lock.yaml ./

# Install the npm packages
RUN pnpm i --prod --frozen-lockfile

# Copy compiled files from build stages
COPY extensions/* ./dist/
COPY server/public ./public
COPY server/start.sh .
COPY --from=build-fsproxy /app/fsproxy/fsproxy-linux-x64-0.0.1.vsix ./dist/fsproxy-0.0.1.vsix
COPY --from=build-server /app/server/dist ./dist

# Expose the server's port
EXPOSE 3000 3100

# Create log directory
RUN mkdir -p /var/log/sfd

# Start x11vnc and the server
CMD ["bash", "start.sh"]
