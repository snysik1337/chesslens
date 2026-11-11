# Builds ui/data/openings.json from the lichess chess-openings TSV files (CC0).
# Key: first three FEN fields (placement, side to move, castling). Value: [eco, name].
import csv, io, json, sys, pathlib
import chess, chess.pgn
here = pathlib.Path(__file__).parent
out = {}
for f in "abcde":
    with open(here / f"{f}.tsv", newline="") as fh:
        for row in csv.DictReader(fh, delimiter="\t"):
            game = chess.pgn.read_game(io.StringIO(row["pgn"]))
            board = game.end().board()
            key = " ".join(board.fen().split(" ")[:3])
            out[key] = [row["eco"], row["name"]]
(here.parent / "ui" / "data" / "openings.json").write_text(json.dumps(out, separators=(",", ":")))
print(len(out), "positions")
