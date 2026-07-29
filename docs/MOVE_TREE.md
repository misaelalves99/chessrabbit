# Move tree & variations — design

*Companion to BLUEPRINT.md §11.2 (the workspace). Specifies the move list
that Chess.com calls the analysis tree: a main line you can branch off
without destroying, rendered as indented side lines.*

---

## 1. What we are building

Today the move list is a flat list of the moves that were played. Playing
a move anywhere except the end **deletes the rest of the game**:

```ts
// AnalysisBoard.tsx:304 — the whole problem in one line
const next = [...history.slice(0, cursor), move.san];
```

Step back to move 12, try `Ng4` to see what would have happened, and moves
13–40 are gone. There is no undo. The single most common thing a player
wants to do while reviewing — *ask a what-if* — is the one thing the board
punishes.

After this change, that same drag creates a **variation**: a branch hanging
off move 12 that renders indented under it, while the game stays intact.

```
12.  c4        Bg4          ← the game
       12... Ng4            ← what if I'd played this
       12... dxc4
       12... Rfe8  13. c4
13.  h3        Bh5          ← the game, still there
14.  cxd5      Nxd5
```

Three siblings under move 12 because you tried three ideas from the same
position. Each is addressable, each is scored by the engine, none of them
touched the game.

---

## 2. The invariant that makes this safe

Commits `a3987b6` and `03026e4` established a rule the review depends on:
**a review row may never be shown against a move it does not describe.**
Annotations are keyed by ply against the server's parse of the PGN; the
board verifies each row's `move_uci` against the move it actually holds at
that ply, and hides rows that disagree.

A naive tree breaks this. If the move list becomes a generic graph of node
ids, `annByPly` has nothing to key against, the eval curve has no x-axis,
and the alignment guard has nothing to compare.

So the tree carries one invariant:

> **The main line is the game.** The path of `children[0]` edges from the
> root is exactly the move list the server parsed, in the same order, at
> the same ply numbers — for the entire life of a loaded game.

Everything the review touches keeps working untouched, because
`mainlinePath(tree).map(n => n.san)` is byte-identical to today's
`history`, and a main-line node's `ply` is today's ply. Variations are an
overlay that the review is simply blind to.

Two consequences fall out of the invariant, and both are features:

- **Promotion is disabled on a loaded game.** "Make this variation the main
  line" is standard in desktop GUIs, but here it would rewrite the ply
  numbering out from under 40 annotation rows. On the free analysis board
  and in repertoire editing (no server review to invalidate) it is allowed.
  On a game, the menu offers *Move up among siblings* instead, which
  reorders `children[1..]` and leaves `children[0]` alone.
- **The coach goes quiet inside a variation.** A variation node has no
  server annotation. Rather than borrow the main-line verdict for that ply
  — which would be the exact bug `a3987b6` fixed, reintroduced — the panel
  says so, and offers the live engine instead. See §6.

---

## 3. Data model

New file: `apps/web/src/lib/moveTree.ts`. Pure data structure, no React,
no chess.js in the type — testable in isolation.

```ts
export type NodeId = number;

export interface MoveNode {
  id: NodeId;
  parent: NodeId | null;      // null only for the root
  children: NodeId[];         // children[0] is the continuation shown inline
  san: string;                // "Nf3"        — for display
  uci: string;                // "g1f3"       — for annotation matching
  fen: string;                // position AFTER this move
  ply: number;                // 0-based; root is -1
  mainline: boolean;          // every ancestor edge was children[0]
  depth: number;              // 0 on the main line, 1 in a variation, 2 nested
  source: "game" | "user" | "engine" | "book";
  evalCp?: number | null;     // engine's score when the branch was created
  comment?: string;
  nag?: number;
}

export interface MoveTree {
  root: NodeId;               // sentinel: start position, ply -1, no san
  nodes: Map<NodeId, MoveNode>;
  nextId: number;
  /** A loaded game's main line is immutable. Set when a PGN is imported. */
  locked: boolean;
}
```

`fen` is stored per node rather than replayed. The board already
materialises every position once per move list (`AnalysisBoard.tsx:131`);
this keeps that property — moving the cursor stays a map lookup, never a
rebuild — and it is what makes an arbitrary jump into a deep variation
instant.

### Insertion — three rules, in order

```
addMove(tree, parentId, san) -> NodeId
```

1. **Legality.** Validate against the parent's `fen` with chess.js. Illegal
   moves return the parent unchanged; the board's drop handler already
   swallows these.
2. **Transpose, don't duplicate.** If a child of `parent` already has this
   SAN, return that child. This is what makes stepping forward through the
   game after exploring feel correct: replaying the game's move re-enters
   the main line instead of forking a duplicate of it. It is also why
   clicking the same engine suggestion twice is idempotent.
3. **Extend or branch.** `mainline = parent.mainline && parent.children.length === 0 && !tree.locked`.

Rule 3 is the whole behaviour in one expression. At the end of the free
analysis board you are extending the main line, exactly as today. Anywhere
else — mid-game, or anywhere in a loaded game — you are creating a sibling.
The `locked` flag is what stops a "Resume from here" continuation from
silently appending itself to a game that is over.

### Other mutations

| Operation | Rule |
|---|---|
| `deleteSubtree(id)` | Drops the node and its descendants. Refuses on a main-line node of a locked tree. |
| `promoteSibling(id)` | Swaps with the previous sibling in `parent.children[1..]`. Never touches index 0. |
| `promoteToMainline(id)` | Only when `!locked`. Rewrites ancestor child order, then recomputes `mainline`/`depth` from the root. |
| `clearVariations(id)` | Truncates `parent.children` to `[children[0]]`. The "I'm done exploring" escape hatch. |

---

## 4. Rendering

New file: `apps/web/src/lib/moveTreeRender.ts`. Flattens the tree into a
row list. Pure function, unit-testable against fixtures — the rendering
rules for chess notation are fiddly enough that they should not be
discovered inside a component.

```ts
type Row =
  | { kind: "pair"; moveNo: number; white?: NodeId; black?: NodeId }
  | { kind: "variation"; depth: number; anchor: NodeId; tokens: Token[] };

type Token =
  | { t: "move"; id: NodeId; san: string; num?: string }  // num = "12." | "12..."
  | { t: "paren"; text: "(" | ")" };
```

Main-line moves emit `pair` rows — the existing three-column grid at
`MoveList.tsx:90` renders these unchanged. Every variation emits one
`variation` row whose tokens flow inline and wrap.

**Move numbering.** A `num` is emitted when the move is White's, when it is
first in the token run, or when the previous token was a paren. That is the
standard PGN rule and it produces exactly what Chess.com shows:

```
7... Ng4  8. O-O  ( 8. Rf1 h6 )
```

**Every side line gets a row; brackets are the exception.** The first draft of
this design put depth 1 on its own row and inlined everything deeper in
parentheses. Building it showed that inverted: a single exploration four
levels deep collapses into one unreadable row, while a two-move refutation
wastes a whole row of a 352px panel.

So the rule is the other way round. Each side line takes a row, indented by
its depth. A line is folded into brackets beside the move it answers only
when it is **at most 4 plies and does not itself branch** — the case brackets
are actually good at. `inlineable()` in `moveTreeRender.ts` is that test, and
the fixtures pin both halves of it.

**Nesting is capped visually, not structurally.** Indentation stops after
three levels so a deep line stays readable instead of walking off the edge;
the tree itself nests without limit.

**Ordering.** Siblings render in insertion order — the order you tried
them. Not sorted by engine score: the sequence is a record of your
thinking, and re-sorting it under you while you explore is disorienting.

### Component surface

`MoveList.tsx` is rewritten to consume `Row[]`, and keeps two things
verbatim: the `CLASS_META` badge rendering, and the `scrollingParent`
centering effect at line 34 — including its comment, which is still the
correct reason not to use `scrollIntoView`.

The active-row tracking changes from `cursor === ply + 1` to
`cursorId === node.id`, which is strictly simpler and removes the off-by-one
the old comparison carried.

---

## 5. Navigation

`cursor: number` becomes `cursorId: NodeId`. The keyboard map at
`AnalysisBoard.tsx:327` gains sibling movement, which every desktop chess
GUI has and no web board does:

| Key | Today | With the tree |
|---|---|---|
| `←` | ply − 1 | parent |
| `→` | ply + 1 | `children[0]` — continues *the line you are in*, not the game |
| `↑` / `↓` | start / end | start of line / end of current line |
| `Alt+↑` / `Alt+↓` | — | previous / next sibling variation at this point |
| `Esc` | — | jump to nearest main-line ancestor |
| `Del` | — | delete the variation under the cursor |

`→` continuing the current line rather than the game is the one that makes
variations usable. `Esc` is the affordance Chess.com is missing — once you
are four moves deep in a side line, getting back to the game is a hunt.

---

## 6. Where variations come from

Four creators, in ascending order of how much they are worth building.

**1. Dragging a piece.** `onDrop` calls `addMove(tree, cursorId, san)`
instead of splicing the array. This is the whole of §1, and it is about a
six-line change.

**2. The opening explorer.** `ExplorerPane` already routes clicks through
`onDrop` (`AnalysisBoard.tsx:524`). It gets branching for free — zero
changes to that component — and clicking through book moves stops being
destructive.

**3. Engine lines.** `EnginePane` currently renders PVs as dead text
(`EnginePane.tsx:69`). Each becomes clickable: inserting the full PV as a
variation with `source: "engine"`, then jumping to its first move. Two
notes:

- The PV arrives as UCI (`services/engine/uci.py:103`) and displays as
  `e2e4 e7e5 g1f3` today, which is close to unreadable. Converting to SAN
  client-side by replaying from the current FEN fixes the display *and*
  produces the SAN the tree needs — one conversion, two payoffs. The
  pattern already exists at `ReviewPanel.tsx:118`.
- Insert the whole line, not just the first move. A PV you have to click
  eight times is a PV nobody explores.

**4. "Best was Nf3" becomes a button.** The review panel already computes
the engine's preferred move and prints it as text
(`ReviewPanel.tsx:180-186`). It tells you what you should have played and
then gives you no way to see it. With a tree, that line becomes: insert
`best_uci` and its continuation as a variation, jump into it.

This is the highest-value item on the page. The data is already computed,
already stored, already on screen — it is one click away from being the
feature the review is actually for, and it is only impossible today because
following it would delete the game.

---

## 7. Persistence

**v1 — local.** Debounced `localStorage`, keyed by `gameId`, with the empty
board filed under `scratch`. Costs nothing, survives a reload, and works
with the static web tier shipped in `7c6938c`. A pasted PGN with no game
behind it has no stable name to file lines under, so it gets none.

Two rules keep the stored form small and safe, both in `treeStorage.ts`:

- **Nothing derived is written.** A node's FEN is sixty bytes of a position
  replayable from its parent in microseconds, and ply, depth and main-line
  standing all fall out of where the move sits. Only the parent, the move,
  and what a person added to it survive the trip — a 14-move tree stores in
  about 600 bytes.
- **A saved tree is adopted only if its main line still matches the game
  being opened.** Re-import a corrected PGN and the old variations would
  otherwise be grafted onto moves they were never about: the same failure
  the review's per-ply alignment check exists to prevent, arriving by a
  different route. A refused entry is deleted, not left to be refused again.

Moves are written in id order, which is creation order: a node is always
created after its parent, so replaying the list start to finish never
references a move that does not exist yet, and siblings keep the order they
were tried in. Deleting a line leaves holes, so ids are renumbered on the
way out and the cursor is remapped with them — nothing outside that file
should hold a node id across a reload.

Eviction caps at 30 games, least recently opened first. A quota error drops
the oldest half and takes one more run at it, then gives up quietly: the
analysis is worth less than crashing the board over.

**v2 — server, over PGN.** PGN already encodes variations natively with
`( )`, python-chess reads and writes them, and `games.movetext` is already
the column. Round-tripping the tree as annotated PGN means no bespoke JSON
schema on the wire and instant interoperability with every other chess
tool. "Copy PGN" ships in v1, which is what makes the analysis portable
today.

### Confirmed: chess.js handles neither half of this

`loadPgn()` reads the main line and silently discards `( )` blocks, and
`pgn()` never emits them. NAGs are lost in both directions too:

```
in   1. e4 e5 2. Nf3 (2. Bc4 Nf6 3. d3) 2... Nc6 {said so} 3. Bb5 $1 a6
out  1. e4 e5 2. Nf3 Nc6 {said so} 3. Bb5 a6
```

Which is exactly the half of the format a move tree is about. So `lib/pgn.ts`
owns both directions, built over chess.js's move generation rather than its
parser: a tokeniser over move numbers, SAN, `( )`, `{ }`, `;`, NAGs and
results, and a writer that puts each rival in brackets straight after the
move it replaces. It is the same walk `prep.py:180-214` does server-side, so
the two agree on what a variation means.

One thing worth keeping: a move that stops making sense kills only the line
it is in. The reader marks that bracket dead and skips to its close, so a
single bad move in one variation costs that variation rather than the rest
of the file.

---

## 8. Change surface

| File | Change |
|---|---|
| `lib/moveTree.ts` | **New.** Node/tree types, `addMove`, `addLine`, delete, promote, `annotate`, `mainlinePath`, `lineTo`. |
| `lib/moveTreeRender.ts` | **New.** Tree → `Row[]` flattener with the notation numbering rules. |
| `lib/pgn.ts` | **New.** Movetext reader and writer that preserve variations, comments and NAGs. |
| `lib/treeStorage.ts` | **New.** Serialise/restore, and the `localStorage` layer with the main-line guard and eviction. |
| `hooks/useMoveTree.ts` | **New.** Tree state, navigation, hydration and the debounced save, so `AnalysisBoard` does not grow another 200 lines. |
| `components/MoveList.tsx` | **Rewrite** against `Row[]`. Keeps the badge rendering and the scroll-centering effect as-is. |
| `components/AnalysisBoard.tsx` | `history`/`cursor` → `tree`/`cursorId`; derive `history` and `cursorPly` for compat; `onDrop` calls `addMove`; keyboard map gains sibling keys; Copy PGN. |
| `components/EnginePane.tsx` | PVs rendered in SAN and made clickable. |
| `components/ReviewPanel.tsx` | "Best was X" becomes a button; the coach callout handles the off-main-line case. |
| `components/ExplorerPane.tsx` | Unchanged. |
| `lib/api.ts`, all of `apps/api`, `services/engine`, `db/migrations` | Unchanged. |

The compat shims in `AnalysisBoard` are what keep this contained:

```ts
const history  = useMemo(() => mainlinePath(tree).map(n => n.san), [tree]);
const node     = tree.nodes.get(cursorId)!;
const onMain   = node.mainline;
const cursorPly = onMain ? node.ply + 1 : -1;   // -1 = off the game
```

`ReviewPanel`, `annByPly`, the eval curve, and the mismatch guard all
receive exactly what they receive today. None of them need to know the tree
exists.

---

## 9. Build order

1. ✅ **`moveTree.ts` + tests.** Insertion rules, transposition, mainline
   flags. No UI. This is where the design is either right or wrong, and it
   is cheap to find out here.
2. ✅ **`moveTreeRender.ts` + tests.** Fixtures for: a bare main line, one
   sibling, three siblings, a nested sub-variation, a variation starting on
   Black's move. Assert the emitted numbering strings.
3. ✅ **Wire `AnalysisBoard` + `MoveList`.** Ship non-destructive branching
   with the compat shims. This alone is the feature.
4. ✅ **Navigation keys** — Alt+↑/↓ across alternatives, Escape back to the
   game, Delete to drop a line, plus the same three as buttons under the
   transport. A right-click row menu is still open.
5. ✅ **Engine lines in SAN, clickable.** Also fixes the unreadable PV row.
6. ✅ **"Best was X" → insert as variation.** The payoff.
7. ✅ **PGN reader/writer, copy-with-variations, localStorage.**

Steps 1–3 are the feature. Steps 5–6 are what make it worth having. Step 7
is what makes it survive a reload and leave the building.

Test infrastructure arrived with step 1: `vitest` is a dev dependency,
`npm test` runs it, and CI runs it between the typecheck and the build. It
was the first JS test runner in the repo — the tree is exactly the kind of
code that is cheap to get right with fixtures and expensive to get right by
clicking. 57 tests across the four modules.

### What is still open

- **A right-click row menu.** Promote, delete and cycle are on keys and on
  buttons under the transport; a context menu on the row itself is the
  conventional home for them.
- **Server sync.** See §10 — deliberate, not forgotten.
- **Collapsing long variation blocks.** Real once lines get long.

## 10. Deliberately not doing

- **Server-side tree storage.** PGN round-trip covers it; a `variations`
  table would be a schema commitment made before we know what people
  branch on.
- **Auto-generated variations.** Filling every mistake with the engine's
  refutation sounds helpful and produces a move list nobody can read. The
  user asks; the tree answers.
- **Promotion on a reviewed game.** See §2. The invariant is worth more
  than the feature.
- **Collapsible variation blocks.** Real once lines get long, but it is
  chrome on top of a flattener that does not exist yet. Revisit after 3.
