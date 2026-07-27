-- Make a review row self-describing.
--
-- Annotations were bound to moves by ply index alone, against a move list the
-- browser re-derives by parsing the PGN itself. When the client's parse and the
-- server's disagreed by even one move, every badge and headline after that
-- point silently described a different move than the one it was drawn on - a
-- review once announced "d4 is a blunder" directly above "Best was d4".
--
-- Recording the move each row is *about* makes that verifiable per ply instead
-- of assumed: the client compares move_uci against the move it holds at that
-- ply and drops anything that does not match, and renders move_san rather than
-- trusting its own parse for the headline.
--
-- Both nullable: rows written before this migration have no move recorded, and
-- the client falls back to the coarser whole-game ply-count check for those.

ALTER TABLE annotations ADD COLUMN move_uci TEXT;
ALTER TABLE annotations ADD COLUMN move_san TEXT;

COMMENT ON COLUMN annotations.move_uci IS
  'The move this row reviews, in UCI. Lets a client verify ply alignment.';
COMMENT ON COLUMN annotations.move_san IS
  'The same move in SAN, from the server''s parse. Displayed verbatim.';
