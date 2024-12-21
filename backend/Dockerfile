FROM node:18-alpine

WORKDIR /app

# Install system dependencies
RUN apk add --no-cache ffmpeg

# Install app dependencies
COPY package.json yarn.lock ./
RUN yarn install

# Copy all backend files
COPY . .

EXPOSE 3000

CMD ["yarn", "dev"]
