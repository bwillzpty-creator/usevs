FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci --omit=dev

COPY . .

EXPOSE 8080

CMD ["npm", "start"]