#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PLATFORM="$(uname -s)"
ARCH="$(uname -m)"

echo "=== WatchTogether: Bundle mpv ==="
echo "Platform: $PLATFORM ($ARCH)"

if [ "$PLATFORM" = "Darwin" ]; then
  OUT_DIR="$PROJECT_DIR/resources/mpv/mac"
  mkdir -p "$OUT_DIR"

  MPV_BIN="$(which mpv 2>/dev/null || echo "")"
  if [ -z "$MPV_BIN" ]; then
    echo "Error: mpv not found. Install with: brew install mpv"
    exit 1
  fi

  echo "Found mpv at: $MPV_BIN"
  cp "$MPV_BIN" "$OUT_DIR/mpv"
  chmod +x "$OUT_DIR/mpv"

  if command -v dylibbundler &> /dev/null; then
    echo "Bundling dylibs with dylibbundler..."
    mkdir -p "$OUT_DIR/lib"
    dylibbundler -b -x "$OUT_DIR/mpv" -d "$OUT_DIR/lib/" -p @executable_path/lib/ -od 2>&1 || {
      echo "Warning: dylibbundler failed. mpv may not work without system libraries."
      echo "Install dylibbundler: brew install dylibbundler"
    }
  else
    echo "Warning: dylibbundler not found. mpv binary may depend on system libraries."
    echo "For a fully portable build: brew install dylibbundler && re-run this script."
  fi

  echo "Done. mpv bundled to: $OUT_DIR"

elif [ "$PLATFORM" = "MINGW64_NT"* ] || [ "$PLATFORM" = "MSYS_NT"* ] || [ "$1" = "win" ]; then
  OUT_DIR="$PROJECT_DIR/resources/mpv/win"
  mkdir -p "$OUT_DIR"

  echo "For Windows: download mpv from https://sourceforge.net/projects/mpv-player-windows/"
  echo "Extract mpv.exe and all .dll files to: $OUT_DIR"
  echo ""
  echo "Or use the following command (requires curl and 7z):"
  echo "  curl -L -o /tmp/mpv.7z 'https://sourceforge.net/projects/mpv-player-windows/files/64bit/mpv-x86_64-20240101-git-abc1234.7z/download'"
  echo "  7z x /tmp/mpv.7z -o$OUT_DIR"

else
  echo "Unsupported platform: $PLATFORM"
  exit 1
fi
