#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
SSL_DIR="${ROOT_DIR}/.local-ssl"

# Ubuntu 24.04+ ships OpenSSL 3; older MongoDB binaries need libssl1.1.
if [ ! -f /lib/x86_64-linux-gnu/libcrypto.so.1.1 ] && [ ! -f /usr/lib/x86_64-linux-gnu/libcrypto.so.1.1 ]; then
  if [ ! -f "${SSL_DIR}/usr/lib/x86_64-linux-gnu/libcrypto.so.1.1" ]; then
    echo "Preparing local OpenSSL 1.1 libraries for MongoDB memory server..."
    mkdir -p "${SSL_DIR}"
    TMP_DEB="$(mktemp /tmp/libssl1.1.XXXXXX.deb)"
    curl -fsSL -o "${TMP_DEB}" \
      http://archive.ubuntu.com/ubuntu/pool/main/o/openssl/libssl1.1_1.1.1f-1ubuntu2.24_amd64.deb
    dpkg -x "${TMP_DEB}" "${SSL_DIR}"
    rm -f "${TMP_DEB}"
  fi
  export LD_LIBRARY_PATH="${SSL_DIR}/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
fi

cd "${ROOT_DIR}"
if [ ! -f .env ]; then
  cp .env.example .env
fi

exec node src/index.js
