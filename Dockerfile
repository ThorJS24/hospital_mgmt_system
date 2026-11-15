# MediCore HMS - academic lab image. One image, two services (backend / frontend dev server).
FROM node:26-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci
COPY backend backend
COPY frontend frontend
COPY shared shared
COPY assessment assessment
COPY lab-data lab-data
# the application never needs root: create the writable directories and hand the tree to the unprivileged "node" user
RUN mkdir -p lab-data/uploads assessment/evidence/files assessment/reports/out && chown -R node:node /app
ENV NODE_ENV=development
USER node
