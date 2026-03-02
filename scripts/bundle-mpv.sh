#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PLATFORM="${1:-$(uname -s)}"
ARCH="$(uname -m)"

echo "=== WatchTogether: Bundle mpv ==="
echo "Platform: $PLATFORM ($ARCH)"

# ── macOS ──
if [ "$PLATFORM" = "Darwin" ] || [ "$PLATFORM" = "mac" ]; then
  OUT_DIR="$PROJECT_DIR/resources/mpv/mac"
  rm -rf "$OUT_DIR"
  mkdir -p "$OUT_DIR/lib"

  MPV_BIN="$(which mpv 2>/dev/null || echo "")"
  if [ -z "$MPV_BIN" ]; then
    echo "Error: mpv not found. Install with: brew install mpv"
    exit 1
  fi

  # Resolve symlinks to get the real binary
  MPV_REAL="$(readlink -f "$MPV_BIN" 2>/dev/null || python3 -c "import os; print(os.path.realpath('$MPV_BIN'))")"
  echo "Found mpv at: $MPV_REAL"
  cp "$MPV_REAL" "$OUT_DIR/mpv"
  chmod +x "$OUT_DIR/mpv"

  # Bundle dylibs
  if command -v dylibbundler &> /dev/null; then
    echo "Bundling dynamic libraries..."
    dylibbundler -b -x "$OUT_DIR/mpv" -d "$OUT_DIR/lib/" -p @executable_path/lib/ -od 2>&1
    echo "dylibbundler complete."
  else
    echo ""
    echo "ERROR: dylibbundler is required for a portable build."
    echo "  Install with: brew install dylibbundler"
    exit 1
  fi

  # Remove quarantine attributes and re-sign everything
  echo "Re-signing binaries..."
  xattr -cr "$OUT_DIR"
  codesign --force --deep --sign - "$OUT_DIR/mpv" 2>/dev/null
  for dylib in "$OUT_DIR/lib/"*.dylib; do
    codesign --force --sign - "$dylib" 2>/dev/null
  done

  # Verify
  echo "Verifying bundled mpv..."
  "$OUT_DIR/mpv" --no-config --vo=null --ao=null --version 2>&1 | head -1

  SIZE=$(du -sh "$OUT_DIR" | awk '{print $1}')
  echo "Done. mpv bundled to: $OUT_DIR ($SIZE)"

# ── Windows ──
elif [ "$PLATFORM" = "win" ] || [[ "$PLATFORM" == MINGW* ]] || [[ "$PLATFORM" == MSYS* ]]; then
  OUT_DIR="$PROJECT_DIR/resources/mpv/win"
  rm -rf "$OUT_DIR"
  mkdir -p "$OUT_DIR"

  MPV_URL="https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/20240414/mpv-x86_64-20240414-git-c0388f4.7z"
  TEMP_FILE="/tmp/mpv-win.7z"

  if command -v curl &> /dev/null; then
    echo "Downloading mpv Windows build..."
    curl -L -o "$TEMP_FILE" "$MPV_URL"

    if command -v 7z &> /dev/null; then
      7z x "$TEMP_FILE" -o"$OUT_DIR" -y
      rm "$TEMP_FILE"
    elif command -v 7zz &> /dev/null; then
      7zz x "$TEMP_FILE" -o"$OUT_DIR" -y
      rm "$TEMP_FILE"
    else
      echo "Error: 7z not found. Install with: brew install p7zip"
      echo "Or manually extract $TEMP_FILE to $OUT_DIR"
      exit 1
    fi

    echo "Done. mpv bundled to: $OUT_DIR"
  else
    echo "Error: curl not found."
    echo ""
    echo "Manual setup: download mpv from one of these sources:"
    echo "  https://github.com/shinchiro/mpv-winbuild-cmake/releases"
    echo "  https://sourceforge.net/projects/mpv-player-windows/"
    echo ""
    echo "Extract mpv.exe and all .dll files to: $OUT_DIR"
    exit 1
  fi

else
  echo "Unsupported platform: $PLATFORM"
  echo "Usage: $0 [mac|win]"
  exit 1
fi
