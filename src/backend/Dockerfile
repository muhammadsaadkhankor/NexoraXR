
FROM node:18-slim

# Install FFmpeg and utilities
RUN apt-get update && apt-get install -y ffmpeg unzip

WORKDIR /app

# Copy package files
COPY package*.json yarn.lock ./
RUN yarn install

# Set up Rhubarb binary
RUN mkdir -p bin
COPY bin ./bin/

# Make ALL binaries in bin directory executable
RUN chmod +x ./bin/*

# Copy the rest of the code
COPY . .

# Create audios directory if it doesn't exist
RUN mkdir -p audios

EXPOSE 3000

# Start the application
CMD ["yarn", "start"]