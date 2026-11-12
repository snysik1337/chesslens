#!/bin/sh
# Chesslens installer.
#
#   curl -fsSL https://raw.githubusercontent.com/snysik1337/chesslens/main/install.sh | sh
#
# Downloads a prebuilt release (AppImage, or a .deb/.rpm where appropriate) and
# installs it per user into ~/.local. If there is no prebuilt release for this
# machine, it installs the build dependencies and compiles from source.
#
# Options:
#   --build          build from source even if a prebuilt release exists
#   --deps-only      install system packages and Rust, then stop
#   --no-deps        do not install system packages
#   --uninstall      remove the installed app
#   --prefix DIR     install prefix (default: ~/.local)
#   --version TAG    install a specific release tag (default: latest)
#   --help           show this help

set -eu

REPO="snysik1337/chesslens"
RAW_URL="https://raw.githubusercontent.com/$REPO/main"
API_URL="https://api.github.com/repos/$REPO/releases"
GITHUB_URL="https://github.com/$REPO"

PREFIX="$HOME/.local"
BUILD=0
DEPS_ONLY=0
NO_DEPS=0
UNINSTALL=0
VERSION=""

TMP=""

info() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
    cat <<'EOF'
Usage: install.sh [options]

  --build          build from source even if a prebuilt release exists
  --deps-only      install system packages and Rust, then stop
  --no-deps        do not install system packages
  --uninstall      remove the installed app
  --prefix DIR     install prefix (default: ~/.local)
  --version TAG    install a specific release tag (default: latest)
  --help           show this help
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --build) BUILD=1 ;;
        --deps-only) DEPS_ONLY=1 ;;
        --no-deps) NO_DEPS=1 ;;
        --uninstall) UNINSTALL=1 ;;
        --prefix)
            [ $# -ge 2 ] || die "--prefix needs a directory"
            PREFIX="$2"
            shift
            ;;
        --version)
            [ $# -ge 2 ] || die "--version needs a tag"
            VERSION="$2"
            shift
            ;;
        --help|-h) usage; exit 0 ;;
        *) die "Unknown option: $1 (see --help)" ;;
    esac
    shift
done

# Run a command as root, using sudo when needed.
as_root() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    else
        command -v sudo >/dev/null 2>&1 || die "This step needs root; run with sudo or as root."
        sudo "$@"
    fi
}

# download URL DEST
download() {
    if command -v curl >/dev/null 2>&1; then
        curl -fL --retry 3 -o "$2" "$1"
    elif command -v wget >/dev/null 2>&1; then
        wget -O "$2" "$1"
    else
        die "Neither curl nor wget is installed."
    fi
}

pkg_manager() {
    if command -v apt-get >/dev/null 2>&1; then echo apt
    elif command -v dnf >/dev/null 2>&1; then echo dnf
    elif command -v pacman >/dev/null 2>&1; then echo pacman
    elif command -v zypper >/dev/null 2>&1; then echo zypper
    elif command -v apk >/dev/null 2>&1; then echo apk
    elif command -v emerge >/dev/null 2>&1; then echo emerge
    else echo unknown
    fi
}

distro_id() {
    if [ -r /etc/os-release ]; then
        . /etc/os-release
        printf '%s' "${ID:-unknown}"
    else
        printf 'unknown'
    fi
}

install_system_deps() {
    [ "$NO_DEPS" = 1 ] && { warn "Skipping system packages (--no-deps)."; return 0; }

    pm="$(pkg_manager)"
    if [ "$pm" = unknown ]; then
        warn "No supported package manager found. Install Tauri's Linux dependencies manually:"
        warn "  https://tauri.app/start/prerequisites/"
        return 0
    fi

    info "Installing system packages for $(distro_id)..."
    case "$pm" in
        apt)
            as_root apt-get update
            as_root apt-get install -y \
                libwebkit2gtk-4.1-dev build-essential curl wget file \
                libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
            ;;
        dnf)
            as_root dnf install -y \
                webkit2gtk4.1-devel openssl-devel curl wget file \
                libappindicator-gtk3-devel librsvg2-devel
            as_root dnf group install -y "C Development Tools and Libraries"
            ;;
        pacman)
            as_root pacman -Sy --noconfirm --needed \
                webkit2gtk-4.1 base-devel curl wget file openssl \
                appmenu-gtk-module libappindicator-gtk3 librsvg xdotool
            ;;
        zypper)
            as_root zypper --non-interactive refresh
            as_root zypper --non-interactive install \
                webkit2gtk3-devel libopenssl-devel curl wget file \
                libappindicator3-1 librsvg-devel
            as_root zypper --non-interactive install -t pattern devel_basis
            ;;
        apk)
            as_root apk add \
                build-base webkit2gtk-4.1-dev curl wget file openssl \
                libayatana-appindicator-dev librsvg font-dejavu
            ;;
        emerge)
            as_root emerge --ask=n \
                net-libs/webkit-gtk:4.1 dev-libs/libappindicator \
                net-misc/curl net-misc/wget sys-apps/file
            ;;
    esac
}

install_rust() {
    if command -v cargo >/dev/null 2>&1; then return 0; fi
    if [ -x "$HOME/.cargo/bin/cargo" ]; then
        export PATH="$HOME/.cargo/bin:$PATH"
        return 0
    fi
    command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 ||
        die "curl or wget is needed to install Rust."
    info "Installing Rust..."
    download "https://sh.rustup.rs" "$TMP/rustup.sh"
    sh "$TMP/rustup.sh" -y --no-modify-path --profile minimal
    export PATH="$HOME/.cargo/bin:$PATH"
    command -v cargo >/dev/null 2>&1 || die "Rust installation failed."
}

fetch_release() {
    command -v curl >/dev/null 2>&1 || return 1
    if [ -n "$VERSION" ]; then
        url="$API_URL/tags/$VERSION"
    else
        url="$API_URL/latest"
    fi
    curl -fsSL -H "User-Agent: chesslens-installer" \
        -H "Accept: application/vnd.github+json" "$url" || true
}

asset_urls() {
    printf '%s\n' "$1" |
        grep -o '"browser_download_url": *"[^"]*"' |
        sed -e 's/^"browser_download_url": *"//' -e 's/"$//' ||
        true
}

is_for_arch() {
    case "$(uname -m)" in
        x86_64|amd64) case "$1" in *amd64*|*x86_64*) return 0 ;; esac ;;
        aarch64|arm64) case "$1" in *arm64*|*aarch64*) return 0 ;; esac ;;
    esac
    return 1
}

select_asset() {
    urls="$(asset_urls "$1")"
    APPIMAGE=""
    DEB=""
    RPM=""
    for u in $urls; do
        is_for_arch "$u" || continue
        case "$u" in
            *.AppImage) APPIMAGE="$u" ;;
            *.deb) DEB="$u" ;;
            *.rpm) RPM="$u" ;;
        esac
    done
}

write_desktop_entry() {
    mkdir -p "$PREFIX/share/applications"
    cat > "$PREFIX/share/applications/chesslens.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Chesslens
Comment=Chess analysis board and game review
Exec="$PREFIX/bin/chesslens"
Icon=chesslens
Categories=Game;BoardGame;
Terminal=false
DESKTOP
}

install_meta() {
    method="$1"
    if download "$RAW_URL/src-tauri/icons/icon.png" "$TMP/icon.png" 2>/dev/null; then
        install -Dm644 "$TMP/icon.png" "$PREFIX/share/icons/hicolor/256x256/apps/chesslens.png"
    else
        warn "Could not download the icon; the app will use a default icon."
    fi
    write_desktop_entry
    mkdir -p "$PREFIX/share/chesslens"
    printf '%s\n' "$method" > "$PREFIX/share/chesslens/install-method"
}

install_appimage() {
    info "Downloading $(basename "$1")..."
    download "$1" "$TMP/chesslens.AppImage"
    magic="$(head -c 4 "$TMP/chesslens.AppImage" | od -An -tx1 | tr -d ' \n')"
    [ "$magic" = "7f454c46" ] || die "The download is not a valid AppImage."
    install -Dm755 "$TMP/chesslens.AppImage" "$PREFIX/bin/chesslens"
    install_meta appimage
    info "Installed $PREFIX/bin/chesslens"
}

install_deb() {
    info "Downloading $(basename "$1")..."
    download "$1" "$TMP/chesslens.deb"
    as_root apt-get install -y "$TMP/chesslens.deb"
    mkdir -p "$PREFIX/share/chesslens"
    printf 'deb\n' > "$PREFIX/share/chesslens/install-method"
    info "Installed chesslens (system package)."
}

install_rpm() {
    info "Downloading $(basename "$1")..."
    download "$1" "$TMP/chesslens.rpm"
    as_root dnf install -y "$TMP/chesslens.rpm"
    mkdir -p "$PREFIX/share/chesslens"
    printf 'rpm\n' > "$PREFIX/share/chesslens/install-method"
    info "Installed chesslens (system package)."
}

try_install_release() {
    json="$(fetch_release)"
    if [ -z "$json" ]; then
        [ -n "$VERSION" ] && warn "Release $VERSION not found."
        return 1
    fi
    select_asset "$json"

    if [ -n "$APPIMAGE" ]; then
        install_appimage "$APPIMAGE"
        return 0
    fi

    pm="$(pkg_manager)"
    if [ -n "$DEB" ] && [ "$pm" = apt ]; then
        install_deb "$DEB"
        return 0
    fi
    if [ -n "$RPM" ] && [ "$pm" = dnf ]; then
        install_rpm "$RPM"
        return 0
    fi

    return 1
}

source_dir() {
    script_dir="$(cd "$(dirname "$0")" && pwd)"
    if [ -f "$script_dir/src-tauri/Cargo.toml" ]; then
        printf '%s' "$script_dir"
        return 0
    fi
    info "Downloading source from GitHub..." >&2
    download "$GITHUB_URL/archive/refs/heads/main.tar.gz" "$TMP/source.tar.gz"
    tar -xzf "$TMP/source.tar.gz" -C "$TMP"
    printf '%s' "$TMP/chesslens-main"
}

build_from_source() {
    src="$(source_dir)"
    install_system_deps
    install_rust
    info "Building Chesslens from source (this takes a few minutes)..."
    (cd "$src/src-tauri" && cargo build --release)
    install -Dm755 "$src/src-tauri/target/release/chesslens" "$PREFIX/bin/chesslens"
    install -Dm644 "$src/src-tauri/icons/icon.png" \
        "$PREFIX/share/icons/hicolor/256x256/apps/chesslens.png"
    write_desktop_entry
    mkdir -p "$PREFIX/share/chesslens"
    printf 'source\n' > "$PREFIX/share/chesslens/install-method"
    info "Installed $PREFIX/bin/chesslens"
}

uninstall() {
    rm -f "$PREFIX/bin/chesslens"
    rm -f "$PREFIX/share/applications/chesslens.desktop"
    rm -f "$PREFIX/share/icons/hicolor/256x256/apps/chesslens.png"
    method_file="$PREFIX/share/chesslens/install-method"
    if [ -f "$method_file" ]; then
        case "$(cat "$method_file")" in
            deb) info "A system .deb was installed; run 'sudo apt remove chesslens' to remove it." ;;
            rpm) info "A system .rpm was installed; run 'sudo dnf remove chesslens' to remove it." ;;
        esac
        rm -rf "$PREFIX/share/chesslens"
    fi
    info "Chesslens removed from $PREFIX."
}

path_hint() {
    case ":$PATH:" in
        *":$PREFIX/bin:"*) ;;
        *) warn "$PREFIX/bin is not in your PATH; run the app directly or add it to PATH." ;;
    esac
}

main() {
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT

    if [ "$UNINSTALL" = 1 ]; then
        uninstall
        return 0
    fi

    if [ "$DEPS_ONLY" = 1 ]; then
        install_system_deps
        install_rust
        info "Dependencies installed."
        return 0
    fi

    if [ "$BUILD" = 0 ] && try_install_release; then
        info "Done. Start it from the app menu or run: $PREFIX/bin/chesslens"
        path_hint
        return 0
    fi

    build_from_source
    info "Done. Start it from the app menu or run: $PREFIX/bin/chesslens"
    path_hint
}

main
