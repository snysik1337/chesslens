#!/bin/sh
# Installs Chesslens for the current user: binary, icon and app-menu entry. No sudo needed.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
bin="$here/src-tauri/target/release/chesslens"
[ -x "$bin" ] || { echo "Build first: (cd src-tauri && ~/.cargo/bin/cargo build --release)"; exit 1; }
install -Dm755 "$bin" "$HOME/.local/bin/chesslens"
install -Dm644 "$here/src-tauri/icons/icon.png" "$HOME/.local/share/icons/hicolor/256x256/apps/chesslens.png"
mkdir -p "$HOME/.local/share/applications"
cat > "$HOME/.local/share/applications/chesslens.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Chesslens
Comment=Chess analysis board and game review
Exec=$HOME/.local/bin/chesslens
Icon=chesslens
Categories=Game;BoardGame;
Terminal=false
DESKTOP
echo "Installed. Start it from the app menu or run: ~/.local/bin/chesslens"
