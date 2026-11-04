#!/usr/bin/env bash
#
# Installs Docker if it is missing, then builds and starts Factorix.
#
#   curl -fsSL https://raw.githubusercontent.com/WebEferen/factorix/main/install.sh | bash
#
# Run it from a checkout to use that checkout. Otherwise it downloads Factorix to $FACTORIX_DIR, or ~/factorix.
# Running it again is safe: an existing .env and its secret key are never replaced.

set -euo pipefail

REPO_URL="https://github.com/WebEferen/factorix"
DOCKER_WAIT_SECONDS=300
DOCKER=(docker)
SUDO=()

say() { printf '==> %s\n' "$*"; }
die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

pick_sudo() {
  [ "$(id -u)" -eq 0 ] && return
  command -v sudo >/dev/null 2>&1 || die "Installing Docker needs root, and sudo is not available. Run this as root, or install Docker yourself: https://docs.docker.com/engine/install/"
  SUDO=(sudo)
}

docker_answers() {
  if docker info >/dev/null 2>&1; then
    DOCKER=(docker)
    return 0
  fi
  # A fresh Linux install only lets root use the socket until the user is added to the docker group.
  if [ "$(uname -s)" = Linux ] && [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    DOCKER=(sudo docker)
    return 0
  fi
  return 1
}

wait_for_docker() {
  say "Waiting for Docker to start"
  local waited=0
  until docker_answers; do
    [ "$waited" -lt "$DOCKER_WAIT_SECONDS" ] || return 1
    sleep 3
    waited=$((waited + 3))
  done
}

install_docker_linux() {
  command -v curl >/dev/null 2>&1 || die "curl is needed to install Docker."
  pick_sudo
  say "Installing Docker with its official script, get.docker.com"
  curl -fsSL https://get.docker.com | "${SUDO[@]}" sh
}

install_docker_mac() {
  command -v brew >/dev/null 2>&1 || die "Install Docker Desktop from https://www.docker.com/products/docker-desktop/, open it once, then run this again. With Homebrew installed, this script can do it for you."
  say "Installing Docker Desktop with Homebrew"
  brew install --cask docker-desktop
}

start_docker() {
  case "$(uname -s)" in
    Darwin)
      say "Opening Docker Desktop. If this is its first run, accept its terms in the window that appears."
      open -a Docker || die "Could not open Docker Desktop."
      ;;
    Linux)
      if command -v systemctl >/dev/null 2>&1; then
        pick_sudo
        "${SUDO[@]}" systemctl enable --now docker || die "Could not start Docker. See: systemctl status docker"
      fi
      ;;
  esac
}

ensure_docker() {
  local system
  system="$(uname -s)"
  if [ "$system" = Darwin ]; then
    PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:$HOME/.docker/bin:/Applications/Docker.app/Contents/Resources/bin"
  fi
  if ! command -v docker >/dev/null 2>&1; then
    case "$system" in
      Linux) install_docker_linux ;;
      Darwin) install_docker_mac ;;
      *) die "This script handles Linux and macOS. Install Docker yourself, then follow the manual steps in the README." ;;
    esac
    command -v docker >/dev/null 2>&1 || die "Docker was installed, but the docker command is not on your PATH. Open a new terminal and run this again."
  fi
  if ! docker_answers; then
    start_docker
    wait_for_docker || die "Docker did not start in time. Start it, then run this again."
  fi
  "${DOCKER[@]}" compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing. See https://docs.docker.com/compose/install/"
}

is_factorix() {
  [ -f "$1/docker-compose.yml" ] && [ -f "$1/.env.example" ] && grep -q '^name: factorix$' "$1/docker-compose.yml"
}

download_to() {
  local target="$1"
  say "Downloading Factorix to $target"
  if command -v git >/dev/null 2>&1; then
    git clone --depth 1 "$REPO_URL.git" "$target"
    return
  fi
  command -v curl >/dev/null 2>&1 || die "Downloading Factorix needs git or curl."
  command -v tar >/dev/null 2>&1 || die "Downloading Factorix without git needs tar."
  mkdir -p "$target"
  curl -fsSL "$REPO_URL/archive/refs/heads/main.tar.gz" | tar -xz --strip-components=1 -C "$target"
}

find_source() {
  local script="${BASH_SOURCE[0]:-}"
  if [ -n "$script" ] && [ -f "$script" ]; then
    local here
    here="$(cd "$(dirname "$script")" && pwd)"
    if is_factorix "$here"; then
      printf '%s\n' "$here"
      return
    fi
  fi
  if is_factorix "$PWD"; then
    printf '%s\n' "$PWD"
    return
  fi
  local target="${FACTORIX_DIR:-$HOME/factorix}"
  if is_factorix "$target"; then
    printf '%s\n' "$target"
    return
  fi
  if [ -e "$target" ] && [ -n "$(ls -A "$target" 2>/dev/null)" ]; then
    die "$target already exists and is not Factorix. Move it, or set FACTORIX_DIR to another folder."
  fi
  download_to "$target" >&2
  printf '%s\n' "$target"
}

new_secret_key() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32
  else
    head -c 32 /dev/urandom | base64 | tr -d '\n'
    printf '\n'
  fi
}

ensure_env() {
  if [ ! -f .env ]; then
    say "Creating .env"
    (umask 077 && cp .env.example .env)
  fi
  if grep -Eq '^FACTORIX_SECRET_KEY=.+' .env; then
    return
  fi
  say "Generating a secret key. It encrypts your stored connections, so keep .env safe."
  local key
  key="$(new_secret_key)"
  [ -n "$key" ] || die "Could not generate a secret key."
  local updated=".env.install.$$"
  (umask 077 && grep -v '^FACTORIX_SECRET_KEY=' .env >"$updated" || true)
  printf 'FACTORIX_SECRET_KEY=%s\n' "$key" >>"$updated"
  chmod 600 "$updated"
  mv "$updated" .env
}

public_url() {
  local url
  url="$(sed -n 's/^FACTORIX_PUBLIC_URL=//p' .env | tail -n 1)"
  printf '%s\n' "${url:-http://localhost:4101}"
}

main() {
  ensure_docker
  local source_dir
  source_dir="$(find_source)"
  cd "$source_dir"
  ensure_env

  say "Building the images. The first build takes several minutes."
  "${DOCKER[@]}" compose --profile build-only build
  say "Starting Factorix"
  "${DOCKER[@]}" compose up -d --wait

  say "Factorix is running at $(public_url)"
  printf 'On a first install, open it and create the admin account. Your files are in %s.\n' "$source_dir"
  printf 'To stop it, run this from that folder: %s compose down\n' "${DOCKER[*]}"
}

main "$@"
