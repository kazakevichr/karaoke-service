FROM node:20-alpine

WORKDIR /app

# yt-dlp (скачивание аудио с YouTube) + ffmpeg на всякий случай для будущих
# конвертаций + yandex-music (запасной источник метаданных/текста, когда
# Spotify недоступен). Без этого слоя работают все функции сервиса, КРОМЕ
# массовой загрузки и запасного источника Яндекс.Музыки.
RUN apk add --no-cache python3 py3-pip ffmpeg \
    && pip3 install --no-cache-dir --break-system-packages yt-dlp yandex-music

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
