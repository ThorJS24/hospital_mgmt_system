# MediCore HMS - academic lab image. One image, two services (backend / frontend dev server).
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci
COPY backend backend
COPY frontend frontend
COPY assessment assessment
COPY lab-data lab-data
ENV NODE_ENV=development
