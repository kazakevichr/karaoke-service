#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Небольшой мост между server.js и библиотекой yandex-music.

Используется как запасной источник метаданных/текста песни, когда Spotify
недоступен (например, требует Premium-подписку у владельца приложения) или
ничего не нашёл по запросу. А также — как ОСНОВНОЙ источник скачивания
самого аудио (см. do_download): YouTube с 2025 года всё активнее блокирует
скачивание с серверных/датацентровых IP, а Яндекс.Музыка пока так агрессивно
не ограничивает — поэтому скачивание сначала пробуем здесь, и только если
не получилось, откатываемся на yt-dlp/YouTube (см. server.js).

Использование:
    python3 ym_lookup.py search "<текстовый запрос>"
    python3 ym_lookup.py lyrics "<текстовый запрос>"
    python3 ym_lookup.py download "<текстовый запрос>" "<путь для сохранения .mp3>"

В search/lyrics в stdout печатается ровно одна строка JSON — её и читает
server.js. Любая ошибка тоже возвращается как JSON с полем "error", чтобы
вызывающая сторона не падала на пустом/невалидном выводе. В download,
помимо метаданных, сам файл сохраняется по указанному пути, а JSON в stdout
только подтверждает успех (поле "ok") и дублирует метаданные.

Токен (переменная окружения YANDEX_MUSIC_TOKEN) необязателен — поиск и
метаданные Яндекс.Музыки по большей части доступны и анонимно. Если хочется
более надёжного доступа (в первую очередь это касается текстов песен) —
получите токен на https://ym.marshal.dev/token/#implicit-oauth и добавьте
его в переменные окружения.
"""
import sys
import os
import json


def make_client():
    from yandex_music import Client
    token = os.environ.get('YANDEX_MUSIC_TOKEN') or None
    return Client(token).init()


def cover_url(cover_uri, size='400x400'):
    if not cover_uri:
        return ''
    return 'https://' + cover_uri.replace('%%', size)


def do_search(query, limit=5):
    client = make_client()
    result = client.search(query, type_='track')
    tracks = []
    if result and result.tracks and result.tracks.results:
        for t in result.tracks.results[:limit]:
            album = t.albums[0] if t.albums else None
            cover = t.cover_uri or (album.cover_uri if album else '')
            tracks.append({
                'title': t.title or '',
                'artist': ', '.join(a.name for a in (t.artists or []) if a.name),
                'album': album.title if album else '',
                'cover': cover_url(cover),
                'trackId': t.id,
                'albumId': album.id if album else None,
            })
    return {'tracks': tracks}


def do_lyrics(query):
    client = make_client()
    result = client.search(query, type_='track')
    if not (result and result.tracks and result.tracks.results):
        return {'lyrics': ''}

    top = result.tracks.results[0]
    try:
        supplement = top.get_supplement()
    except Exception:
        return {'lyrics': ''}

    text = ''
    lyrics_obj = getattr(supplement, 'lyrics', None) if supplement else None
    if lyrics_obj is not None:
        text = getattr(lyrics_obj, 'full_lyrics', '') or ''
    return {'lyrics': text}


def do_download(query, out_path):
    client = make_client()
    result = client.search(query, type_='track')
    if not (result and result.tracks and result.tracks.results):
        return {'error': 'Трек не найден в Яндекс.Музыке'}

    top = result.tracks.results[0]
    try:
        # Яндекс сам отдаёт готовый mp3-поток нужного битрейта — локальный
        # ffmpeg/транскодирование не требуется.
        top.download(out_path, codec='mp3', bitrate_in_kbps=192)
    except Exception as e:
        return {'error': f'Не удалось скачать через Яндекс.Музыку: {e}'}

    if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
        return {'error': 'Яндекс.Музыка не отдала файл (пустой ответ)'}

    album = top.albums[0] if top.albums else None
    return {
        'ok': True,
        'title': top.title or '',
        'artist': ', '.join(a.name for a in (top.artists or []) if a.name),
        'album': album.title if album else '',
        'cover': cover_url(top.cover_uri or (album.cover_uri if album else '')),
    }


def main():
    if len(sys.argv) < 3:
        print(json.dumps({'error': 'Использование: ym_lookup.py <search|lyrics|download> <запрос> [путь]'}))
        sys.exit(1)

    mode, query = sys.argv[1], sys.argv[2]
    try:
        if mode == 'search':
            out = do_search(query)
        elif mode == 'lyrics':
            out = do_lyrics(query)
        elif mode == 'download':
            if len(sys.argv) < 4:
                out = {'error': 'Для download нужен путь для сохранения файла'}
            else:
                out = do_download(query, sys.argv[3])
        else:
            out = {'error': f'Неизвестный режим: {mode}'}
        print(json.dumps(out, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'error': str(e)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == '__main__':
    main()
