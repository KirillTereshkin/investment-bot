"""Интеграция с брокером: Tinkoff Invest, только чтение (Часть 4).

Пакет назван `broker`, а не `tinkoff`, осознанно: SDK ставится как top-level пакет
`tinkoff`, и локальная папка `tinkoff/` перехватила бы импорт
`from tinkoff.invest import Client` (Python ищет пакеты в корне проекта раньше site-packages).
"""
