#!/bin/sh
# Runs the logic tests (grading rules, PGN handling, helpers). No window, no engine.
# Uses a throwaway profile so your settings and library are never touched.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
bin="$here/src-tauri/target/release/chesslens"
[ -x "$bin" ] || { echo "Build first: (cd src-tauri && cargo build --release)"; exit 1; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
XDG_DATA_HOME="$tmp" timeout 120 "$bin" --test
