
FROM node:18-slim

# Install FFmpeg and utilities
RUN apt-get update && apt-get install -y ffmpeg unzip

WORKDIR /app

# Copy package files and install dependencies for both services
COPY nexora_server/package*.json ./nexora_server/
COPY nexora_ai/package*.json ./nexora_ai/
RUN cd nexora_server && npm install && cd ../nexora_ai && npm install

# Set up Rhubarb binary
COPY nexora_ai/bin ./nexora_ai/bin/
RUN chmod +x ./nexora_ai/bin/*

# Copy the rest of the code
COPY nexora_server ./nexora_server
COPY nexora_ai ./nexora_ai

# Create audios directory if it doesn't exist
RUN mkdir -p nexora_ai/audios

EXPOSE 3000

# Start the application
WORKDIR /app/nexora_server
CMD ["npm", "start"]
