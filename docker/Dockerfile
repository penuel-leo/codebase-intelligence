FROM node:20-slim

# Install git (needed for clone/pull operations)
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package.json ./
COPY packages/core/package.json packages/core/
COPY packages/providers/package.json packages/providers/
COPY packages/cli/package.json packages/cli/

# Install dependencies
RUN npm install --workspaces --include-workspace-root

# Copy source
COPY . .

# Build
RUN npm run build

# Data volume
VOLUME /data

# Default config location
ENV CI_CONFIG_PATH=/data/config.yaml
ENV CI_DATA_DIR=/data

ENTRYPOINT ["node", "packages/cli/dist/index.js"]
CMD ["sync"]
