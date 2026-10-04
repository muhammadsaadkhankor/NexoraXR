FROM node:18-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy all frontend files
COPY . .

# Expose Vite's default port
EXPOSE 5173

# Start the app
CMD ["npm", "run", "dev", "--", "--host"]
