# FROM node:18-alpine

# WORKDIR /app

# # Install system dependencies
# RUN apk add --no-cache ffmpeg

# # Install app dependencies
# COPY package.json yarn.lock ./
# RUN yarn install

# # Copy all backend files
# COPY . .

# EXPOSE 3000

# CMD ["yarn", "dev"]



# backend/Dockerfile
FROM node:18-alpine

WORKDIR /app

# Install system dependencies including unzip
RUN apk add --no-cache ffmpeg unzip

# Copy package files first
COPY package.json yarn.lock ./
RUN yarn install

# Copy all backend files
COPY . .

# Extract bin.zip
RUN unzip -o bin.zip -d bin && \
    chmod +x bin/rhubarb

EXPOSE 3000

CMD ["yarn", "dev"]