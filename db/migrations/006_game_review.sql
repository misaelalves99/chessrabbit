-- Game Review (chess.com-style): every move gets a classification and a
-- rule-based explanation. `comment` stays reserved for the user's own notes;
-- the engine writes to `review` so re-running a review never clobbers them.
ALTER TABLE annotations ADD COLUMN classification TEXT;  -- book|best|excellent|good|inaccuracy|mistake|blunder
ALTER TABLE annotations ADD COLUMN review TEXT;          -- generated explanation
