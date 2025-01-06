FROM node:18-alpine
WORKDIR /app
# Install system dependencies including unzip
RUN apk add --no-cache ffmpeg unzip
# Copy package files first
COPY package.json yarn.lock ./
RUN yarn install
# Copy all backend files
COPY . .
# Extract bin.zip and handle Windows executable
RUN unzip -o bin.zip -d bin && \
    mv bin/rhubarb.exe bin/rhubarb && \
    chmod +x bin/rhubarb
EXPOSE 3000
CMD ["yarn", "dev"]