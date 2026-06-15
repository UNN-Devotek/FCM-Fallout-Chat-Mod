FROM node:20-alpine AS builder
ARG VITE_DEV_PERSONAS=false
ENV VITE_DEV_PERSONAS=$VITE_DEV_PERSONAS
WORKDIR /app
COPY package*.json ./
RUN npm ci --include=dev
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 3000
