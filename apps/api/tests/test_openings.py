"""
Naming an opening from whatever the PGN recorded, and folding the named
groups into the rows Insights draws.
"""

from app.core.chess_utils import opening_of, parse_pgn
from app.core.openings import eco_family, name_from_eco_url, opening_label
from app.services.insights import _openings_payload

CHESSCOM_PGN = """[Event "Live Chess"]
[Site "Chess.com"]
[Date "2026.01.04"]
[White "alice"]
[Black "bob"]
[Result "1-0"]
[ECO "C50"]
[ECOUrl "https://www.chess.com/openings/Italian-Game-Giuoco-Pianissimo-4.d3-Nf6"]
[TimeControl "600"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 1-0
"""

LICHESS_PGN = """[Event "Rated rapid game"]
[Site "https://lichess.org/abc123"]
[White "alice"]
[Black "bob"]
[Result "0-1"]
[ECO "B12"]
[Opening "Caro-Kann Defense: Advance Variation"]
[TimeControl "600+0"]

1. e4 c6 2. d4 d5 3. e5 0-1
"""


class TestNameFromEcoUrl:
    def test_reads_the_variation_chesscom_named(self):
        assert name_from_eco_url(
            "https://www.chess.com/openings/Sicilian-Defense-Najdorf-Variation"
        ) == "Sicilian Defense Najdorf Variation"

    def test_drops_the_moves_so_one_opening_is_one_row(self):
        # These are the same opening; keeping the tail would split it in two.
        white = name_from_eco_url(
            "https://www.chess.com/openings/Italian-Game-Giuoco-Pianissimo-4.d3-Nf6"
        )
        black = name_from_eco_url(
            "https://www.chess.com/openings/Italian-Game-Giuoco-Pianissimo-4.d3-d6"
        )
        assert white == black == "Italian Game Giuoco Pianissimo"

    def test_restores_the_apostrophe_a_slug_cannot_hold(self):
        assert name_from_eco_url(
            "https://www.chess.com/openings/Kings-Indian-Defense"
        ) == "King's Indian Defense"

    def test_leaves_a_plural_that_is_not_a_possessive_alone(self):
        assert name_from_eco_url(
            "https://www.chess.com/openings/Four-Knights-Game"
        ) == "Four Knights Game"

    def test_ignores_a_url_that_is_not_an_opening(self):
        assert name_from_eco_url("https://example.com/x/Made-Up-Name") is None
        assert name_from_eco_url("") is None
        assert name_from_eco_url(None) is None


class TestEcoFamily:
    def test_names_the_family_a_code_belongs_to(self):
        assert eco_family("C50") == "Italian Game"
        assert eco_family("B12") == "Caro-Kann Defense"
        assert eco_family("E97") == "King's Indian Defense"

    def test_every_code_in_the_range_resolves(self):
        codes = [f"{letter}{n:02d}" for letter in "ABCDE" for n in range(100)]
        assert all(eco_family(code) for code in codes)

    def test_rejects_anything_that_is_not_a_code(self):
        assert eco_family("X99") is None
        assert eco_family("C5") is None
        assert eco_family(None) is None


class TestOpeningLabel:
    def test_prefers_the_name_the_game_carried(self):
        assert opening_label("Ruy Lopez: Berlin Defense", "C65") == (
            "Ruy Lopez: Berlin Defense"
        )

    def test_falls_back_to_the_family_of_the_code(self):
        assert opening_label(None, "C50") == "Italian Game"
        assert opening_label("  ", "B20") == "Sicilian Defense"
        assert opening_label("?", "D10") == "Slav Defense"

    def test_says_unknown_rather_than_inventing_one(self):
        assert opening_label(None, None) == "Unknown opening"
        assert opening_label("", "not a code") == "Unknown opening"


class TestParsedGames:
    def test_chesscom_game_keeps_its_name(self):
        game = parse_pgn(CHESSCOM_PGN)[0]
        assert game["eco"] == "C50"
        assert game["opening"] == "Italian Game Giuoco Pianissimo"

    def test_lichess_header_still_wins(self):
        game = parse_pgn(LICHESS_PGN)[0]
        assert game["opening"] == "Caro-Kann Defense: Advance Variation"

    def test_a_game_naming_nothing_stores_nothing(self):
        assert opening_of({"Opening": "?"}) is None
        assert opening_of({}) is None


class TestOpeningsPayload:
    # (colour, name, eco, games, wins, draws) - the shape the SQL pass returns.
    def test_unnamed_codes_become_their_own_rows(self):
        payload = _openings_payload([
            ("w", None, "C50", 6, 5, 0),
            ("w", None, "B12", 3, 1, 1),
        ])
        assert [r["name"] for r in payload["white"]] == [
            "Italian Game", "Caro-Kann Defense",
        ]
        assert payload["white"][0]["losses"] == 1

    def test_groups_of_the_same_opening_merge(self):
        payload = _openings_payload([
            ("b", "Sicilian Defense", "B20", 3, 2, 0),
            ("b", "Sicilian Defense", "B21", 2, 0, 1),
        ])
        row = payload["black"][0]
        assert row["games"] == 5 and row["wins"] == 2 and row["losses"] == 2
        # The code most of the row is made of.
        assert row["eco"] == "B20"

    def test_one_off_openings_are_left_out(self):
        payload = _openings_payload([("w", "French Defense", "C00", 1, 1, 0)])
        assert payload["white"] == []

    def test_rows_are_ranked_and_capped(self):
        rows = [("w", f"Opening {i}", None, 20 - i, 0, 0) for i in range(15)]
        white = _openings_payload(rows)["white"]
        assert len(white) == 12
        assert [r["games"] for r in white] == sorted(
            (r["games"] for r in white), reverse=True
        )

    def test_colours_stay_separate(self):
        payload = _openings_payload([
            ("w", "London System", "D02", 4, 2, 1),
            ("b", "London System", "D02", 2, 0, 0),
        ])
        assert payload["white"][0]["games"] == 4
        assert payload["black"][0]["games"] == 2
