#!/usr/bin/env bash
# Установка и обновление сервиса на сервере магазина (Ubuntu 22.04/24.04). Запуск из папки с кодом:
#   sudo bash /opt/ozon-tilda/deploy/install.sh
# Повторный запуск безопасен: .env, база (pgdata) и сертификаты (caddy) не трогаются,
# пересобирается только приложение. Потом — ozon-tilda setup.
set -euo pipefail
DIR=/opt/ozon-tilda
[ "$(id -u)" -eq 0 ] || { echo "Запустите через sudo"; exit 1; }
cd "$DIR"

echo "→ Пакеты (Docker, git)"
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose-v2 git curl openssl >/dev/null
  systemctl enable --now docker >/dev/null
fi

# На 2 ГБ памяти сборке и Postgres тесно — подстраховка.
if [ "$(swapon --show --noheadings | wc -l)" -eq 0 ] && [ ! -f /swapfile ]; then
  echo "→ Файл подкачки 2 ГБ"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if [ ! -f .env ]; then
  echo "→ Создаю .env (режим Ozon: тестовый, пока не введены ключи)"
  cp env.example .env
  chmod 600 .env
  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 24)|" .env
  sed -i "s|^SHOP_KEYS_KEY=.*|SHOP_KEYS_KEY=$(openssl rand -base64 32)|" .env
fi

# Git — чтобы правки кода (свои или ИИ-агентом) было видно и можно было откатить.
if [ ! -d .git ]; then
  git init -q -b main
  git config user.name "ozon-tilda"
  git config user.email "ozon-tilda@localhost"
  git add -A && git commit -q -m "Установка" || true
fi

echo "→ Сборка и запуск (несколько минут)"
docker compose build -q app
docker compose up -d app db
if [[ "$(grep -E '^PUBLIC_URL=' .env | cut -d= -f2-)" == https://* ]]; then
  docker compose --profile https up -d
fi

ln -sf "$DIR/deploy/ozon-tilda" /usr/local/bin/ozon-tilda
chmod +x "$DIR/deploy/ozon-tilda"

for _ in $(seq 1 30); do
  if docker exec ozon-tilda-app wget -qO- http://127.0.0.1:3000/ozon-tilda/health >/dev/null 2>&1; then
    echo "✓ Сервис запущен. Дальше: ozon-tilda setup"
    exit 0
  fi
  sleep 2
done
echo "✕ Сервис не ответил — посмотрите: docker logs ozon-tilda-app --tail 50"
exit 1
