FROM node:20-alpine

WORKDIR /app

# yt-dlp (скачивание аудио с YouTube) + ffmpeg на всякий случай для будущих
# конвертаций. Без этого слоя работают все функции сервиса, КРОМЕ массовой
# загрузки треков — она требует yt-dlp в PATH.
RUN apk add --no-cache python3 py3-pip ffmpeg \
    && pip3 install --no-cache-dir --break-system-packages yt-dlp

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
