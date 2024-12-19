FROM node:18-alpine

WORKDIR /app

# Install system dependencies
RUN apk add --no-cache ffmpeg unzip

# Install app dependencies
COPY package.json yarn.lock ./
RUN yarn install

# Copy and extract bin.zip first
COPY bin.zip ./
RUN unzip bin.zip && rm bin.zip

# Copy rest of the files
COPY . .

EXPOSE 3000

CMD ["yarn", "dev"]