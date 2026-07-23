FROM node:20-alpine

WORKDIR /app

# ffmpeg на всякий случай для будущих конвертаций + yandex-music (запасной
# источник метаданных/текста, когда Spotify недоступен). yt-dlp сюда
# намеренно НЕ ставим — см. комментарий ниже, после COPY.
RUN apk add --no-cache python3 py3-pip ffmpeg \
    && pip3 install --no-cache-dir --break-system-packages yandex-music

COPY package*.json ./
RUN npm install --production

COPY . .

# yt-dlp (скачивание аудио с YouTube) ставим здесь, ПОСЛЕ COPY, а не рядом с
# ffmpeg/yandex-music выше. Так этот шаг пересобирается заново при каждом
# деплое (любое изменение файлов проекта сбрасывает кэш Docker для всех
# слоёв после COPY) и всегда подтягивает самую свежую версию yt-dlp.
# YouTube регулярно меняет защиту от скачивания — если этот слой закэшируется
# и не будет обновляться, через какое-то время скачивание начнёт падать с
# ошибкой "HTTP Error 403: Forbidden", хотя ничего в коде не менялось.
RUN pip3 install --no-cache-dir --break-system-packages --upgrade yt-dlp

EXPOSE 3000

CMD ["npm", "start"]
