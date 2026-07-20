-- Store the engine's best move alongside each annotation so blunders can
-- become training puzzles without re-running the engine.
ALTER TABLE annotations ADD COLUMN best_uci TEXT;
