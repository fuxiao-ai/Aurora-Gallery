#!/usr/bin/env bash
# 在 macOS 上执行：产出 DMG（x64 + arm64，与 package.json 中 mac 配置一致）
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[pack-mac] Node:"
node -v

echo "[pack-mac] Rebuild native modules for Electron..."
npm run rebuild-native

echo "[pack-mac] electron-builder mac dmg..."
npm run dist:mac

echo "[pack-mac] Done. Output: release/"
