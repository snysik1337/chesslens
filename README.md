# Chesslens

Chess analysis board for Linux (Tauri + plain JavaScript).

- One-click engine downloads (Stockfish, Patricia, Viridithas, PlentyChess, Stormphrax, Reckless) picked for your CPU, or add any UCI engine file.
- Live analysis: eval bar, multiple lines (hover a move to preview it), best-move arrow.
- Automatic move grading: Brilliant / Great / Best / Excellent / Good / Book / Inaccuracy / Mistake / Miss / Blunder, as you play and when a game is loaded.
- Game Review: accuracy and a rough rating estimate per player, eval graph, key-move navigation, a sentence of explanation per move, and "Retry mistakes".
- Play against any installed engine at a chosen strength, then review the game.
- Book moves for the current position (from the bundled opening list), position editor, saved-games library, PGN export with grades.
- Load games by pasting PGN/FEN, opening a PGN file, or by Chess.com / Lichess username. Clocks and captured pieces are shown.
- Board colour themes, six open-licensed piece sets, piece animation and sounds.
- Insights: batch-review your games and see accuracy by opening, time control, colour and game phase.
- Per-game phase accuracy and a time-per-move chart; a Threats toggle showing what the opponent is threatening.
- Opening repertoire trainer: save lines and get quizzed on them.
- Resizable side panel, board-only mode (B), and update notices for downloaded engines.

## Build and run

    cd src-tauri && ~/.cargo/bin/cargo build --release
    ./target/release/chesslens

`./install.sh` adds it to the app menu (per user, no sudo).
`chesslens --selftest` exercises the app end to end (install, review, grading, play mode, username import) and prints the results. Run it with `XDG_DATA_HOME` pointing at a temporary folder, because it changes saved settings.

Needs `webkit2gtk-4.1` at runtime. Engines and their list live in `~/.local/share/io.chesslens.app/`.

## Tests

    ./run-tests.sh

Runs the logic tests in `ui/js/tests.js` (grading rules, PGN handling, helpers) without showing a window or needing an engine.

## Layout

- `src-tauri/src/main.rs` – commands: engine process, downloads, game fetching
- `src-tauri/src/engines.rs` – engine catalog, installer, UCI check
- `ui/js/app.js` – interface and game tree
- `ui/js/review.js` – move classification and accuracy
- `ui/js/engine.js` – UCI client, `ui/js/board.js` – board
- `ui/js/tests.js` – logic tests
- `ui/js/extras.js` – sounds, material count, clocks, rating estimate, editor FEN helpers
- `tools/` – scripts that generated `ui/data/openings.json` and the icon
