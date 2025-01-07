FROM node:18-alpine

WORKDIR /app

# Install system dependencies including unzip
RUN apk add --no-cache ffmpeg unzip

# Copy package files first
COPY package*.json yarn.lock ./
RUN yarn install

# Create bin directory
RUN mkdir -p bin

# Copy bin directory first
COPY bin ./bin/

# Make sure rhubarb has executable permissions
RUN if [ -f bin/rhubarb.exe ]; then \
    cp bin/rhubarb.exe bin/rhubarb && \
    chmod +x bin/rhubarb; \
fi

# Copy remaining backend files
COPY . .

EXPOSE 3000

# Use array syntax for CMD
CMD ["yarn", "dev"]