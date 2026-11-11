#!/usr/bin/env bash
# Установка «Доставки Ozon для Tilda» на чистый сервер Ubuntu 22.04 / 24.04 одной командой:
#   curl -fsSL https://raw.githubusercontent.com/nikisidiman/ozon-tilda-selfhost/main/install.sh | sudo bash
# или, если код уже скачан:  sudo bash install.sh
#
# Что делает: ставит git, скачивает код в /opt/ozon-tilda (или обновляет его), затем запускает
# deploy/install.sh — он ставит Docker, генерирует пароли, собирает и запускает сервис.
# Повторный запуск безопасен: настройки (.env), база и сертификаты не трогаются.
# После установки: sudo ozon-tilda setup
set -euo pipefail
REPO_URL=${REPO_URL:-https://github.com/nikisidiman/ozon-tilda-selfhost.git}
DIR=/opt/ozon-tilda

[ "$(id -u)" -eq 0 ] || { echo "Запустите через sudo: sudo bash install.sh"; exit 1; }

if [ -r /etc/os-release ]; then . /etc/os-release; fi
if [ "${ID:-}" != ubuntu ]; then
  echo "⚠ Установщик проверен на Ubuntu 22.04 и 24.04, а здесь ${PRETTY_NAME:-неизвестная система}."
  echo "  Надёжнее переустановить сервер на Ubuntu 24.04 в панели хостинга. Продолжаю через 10 секунд (Ctrl+C — отмена)…"
  sleep 10
fi

if ! command -v git >/dev/null; then
  echo "→ Ставлю git"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl ca-certificates >/dev/null
fi

if [ -d "$DIR/.git" ]; then
  echo "→ Код уже есть в $DIR — обновляю"
  git -C "$DIR" pull -q --ff-only || echo "  ⚠ Обновить не вышло (свои правки?) — собираю то, что есть"
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  echo "✕ Папка $DIR уже есть и не пустая, но это не git. Переименуйте её и запустите ещё раз."
  exit 1
else
  # Запуск из скачанной папки с кодом — берём адрес репозитория у неё.
  # (при запуске через curl | bash файла скрипта нет — тогда берём REPO_URL.)
  here=""
  if [ -f "${BASH_SOURCE[0]:-}" ]; then here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd); fi
  if [ -n "$here" ] && [ -d "$here/.git" ] && [ "$here" != "$DIR" ]; then
    REPO_URL=$(git -C "$here" remote get-url origin 2>/dev/null || echo "$REPO_URL")
  fi
  echo "→ Скачиваю код в $DIR"
  git clone -q "$REPO_URL" "$DIR"
fi

exec bash "$DIR/deploy/install.sh"
