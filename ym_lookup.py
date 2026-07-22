#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Небольшой мост между server.js и библиотекой yandex-music.

Используется как запасной источник метаданных/текста песни, когда Spotify
недоступен (например, требует Premium-подписку у владельца приложения) или
ничего не нашёл по запросу.

Использование:
    python3 ym_lookup.py search "<текстовый запрос>"
    python3 ym_lookup.py lyrics "<текстовый запрос>"

В обоих случаях в stdout печатается ровно одна строка JSON — её и читает
server.js. Любая ошибка тоже возвращается как JSON с полем "error", чтобы
вызывающая сторона не падала на пустом/невалидном выводе.

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


def main():
    if len(sys.argv) < 3:
        print(json.dumps({'error': 'Использование: ym_lookup.py <search|lyrics> <запрос>'}))
        sys.exit(1)

    mode, query = sys.argv[1], sys.argv[2]
    try:
        if mode == 'search':
            out = do_search(query)
        elif mode == 'lyrics':
            out = do_lyrics(query)
        else:
            out = {'error': f'Неизвестный режим: {mode}'}
        print(json.dumps(out, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'error': str(e)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == '__main__':
    main()
