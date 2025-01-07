FROM node:18-alpine

WORKDIR /app

# Install system dependencies including unzip
RUN apk add --no-cache ffmpeg unzip

# Copy package files first
COPY package*.json yarn.lock ./
RUN yarn install

# Copy all backend files
COPY . .

# Extract bin.zip and handle executable with conditional rename
RUN unzip -o bin.zip -d bin && \
    if [ -f bin/rhubarb.exe ]; then \
        cp bin/rhubarb.exe bin/rhubarb; \
    fi && \
    chmod +x bin/rhubarb*

EXPOSE 3000

# Use array syntax for CMD
CMD ["yarn", "dev"]