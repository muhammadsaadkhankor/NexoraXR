FROM node:18-alpine

WORKDIR /app

# Install dependencies
COPY package.json yarn.lock ./
RUN yarn install

# Copy all frontend files
COPY . .

# Expose Vite's default port
EXPOSE 5173

# Start the app
CMD ["yarn", "dev", "--host"]