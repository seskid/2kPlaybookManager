# 2K5 Playbook Manager

A tool for ESPN NFL 2K5 playbooks. Its main feature is **modifying plays and formations**; it also
converts custom playbook saves from Xbox to PS2 and compares playbooks byte-by-byte.
It runs either as a Windows desktop app (Electron) or as a plain web page: open `index.html` in a browser.
Both use the same code.

## Features
- **Modify plays** (see [Edit playbook](#edit-playbook)): pick any run, pass or defensive play, click a
  player on the field, and change their routes, blocks, handoffs, rush lanes, zone/man coverage and
  timing. You can also change a defender's job to another job he has in the same formation.
- **Modify formations** (see [Edit formations](#edit-formations)): drag players to new spots, rename the
  formation, and choose which personnel packages it can run. Every play in the formation picks up the
  new alignment, and the tool checks that the result is a legal football formation.
- **Swap the whole defense** (see [Swap the whole defense](#swap-the-whole-defense-eg-4-3-to-3-4)):
  replace a book's defense with another team's, such as 4-3 to 3-4.
- **Convert** Xbox saves to PS2 `.max` or `.psu`, and **save edited books** for either console.
- **Compare** two playbooks byte-by-byte.

Edits only reuse existing plays, formations and steps, and each one must pass the game's own play
check, so an edited book stays valid for the game.

## Desktop app
```
npm install        # first time only
npm start          # run the app
npm run dist       # build both Windows versions into dist/
```
`npm run dist` builds three files:
- **`2K5-Playbook-Manager-Setup-<version>.exe`**: the installer. It installs for the current user
  (no admin prompt) into `%LOCALAPPDATA%\Programs\2K5 Playbook Manager`, adds Start-menu and desktop
  shortcuts, and includes an uninstaller. Pinning to the taskbar works normally.
- **`2K5-Playbook-Manager-<version>-win.zip`**: no installer. Unzip it anywhere and run
  `2K5 Playbook Manager.exe`; pinning works because the program stays in that folder.
- **`2K5-Playbook-Manager-<version>.exe`**: the single-file portable version. It unpacks itself to a
  temporary folder each time it starts, so don't pin its running window to the taskbar (the pin would
  point at that temporary copy). Pin a shortcut to the exe itself instead.

Your settings (last-used folders) are kept when you uninstall or switch versions.
The desktop app adds these over the browser version:
- Native folder picker. It reads only `SAVEGAME.DAT` and `SaveMeta.xbx`, so pointing it at a whole `UDATA/53450030` folder works.
- Save As dialogs.
- **Save all to folder**, which writes every converted save at once.
- **Show in folder** after saving.
- It remembers the last input and output folders.

If `npm start` only prints Node output and no window opens, the environment variable `ELECTRON_RUN_AS_NODE` is set.
Some editors set it. Clear it for that terminal first.

## Convert
Load Xbox save folders, each with `SAVEGAME.DAT` and `SaveMeta.xbx`, or a parent folder.
Other saves (rosters, franchises, settings) are skipped automatically.
Pick `.max` (AR MAX) or `.psu` (uLaunchELF), then save.

What it does:
1. Copies the 78,736-byte playbook (`PLAY`/`plb`) unchanged. The layout is identical on both consoles.
2. Replaces header words 0x10–0x1F (pointers saved from console memory) with the PS2 values.
3. Writes the PS2 save files `icon.sys`, `VIEW.ICO`, `TYPE`, `BASLUS-20919<CODE>` and `EXTRA` (CRC32 of the playbook).
4. Packs them as `.max` (LZARI-compressed, with a CRC32 header) or `.psu`.

## Edit playbook
Open a playbook in the **Edit playbook** tab: click **Edit playbook** on a book in the Convert tab, or drop an
Xbox save folder, `SAVEGAME.DAT`, `.max` or `.psu`. Pick a run or pass play, click a player on the field,
and change their existing steps:

| Step | What you can change |
|---|---|
| Route segment | Route type (straight, 30°/45°/60° breaks, in, out, comeback, chip…) and distance |
| Block leg | Block type (drive, pass set, pull, release-then-block, lead), delay, turn, sideways/downfield offsets |
| Take handoff | Aim lane (1–8) and delay |
| Run path, release, run to point | Sideways and downfield offsets |
| QB drop | Drop depth |
| Start | Start delay |
| Rush lane (defense) | Rush gap (0 = 7.5 yd left … 8 = over the ball … 16 = 7.5 yd right) and delay |
| Zone coverage (defense) | Zone spot: sideways and depth |
| Man coverage (defense) | Cushion |

Switch the play list between **Offense** and **Defense**. Defensive plays are either fronts (the
line's rush gaps) or coverages (linebacker and DB zones/man). The game pairs one of each on the
field, so defenders a play leaves blank are shown faded and labelled as set by the paired call.
**Changing a defender's job.** In a coverage or blitz, the **Job** dropdown above a defender's steps
lists every job that same player has in the formation's other calls: blitzes (rush gap), zone drops
and man coverage, each labelled with the call it comes from. Picking one points him at that call's
own steps, so nothing new is created, and the change must pass the game's play check. You can then
tune the new job's values as usual. Linemen in a coverage can be dropped into a zone or left to the
front. Linebackers and DBs are never left unassigned, because no front would cover them. Fronts
have no job picker: a coverage overrides the front for every defender it assigns.

How editing works:
- **Only existing plays and steps.** Nothing is ever added: no plays, no formations, no extra steps.
  Step types, flags and counts never change, only the values above.
- **Only the chosen play changes.** About 80% of route data is shared between plays. The first edit
  to a shared player gives that player a private copy of their steps, using a few of the book's spare
  steps (shown in the header). Edits to unshared players are made in place.
- **Every edit must pass the game's own play check** (ported from 2k-football-mod-tools). A change the
  game would reject is refused, and the play is left as it was.
- **Reset play** restores the original play exactly.
- **Save for PS2** writes `.max`/`.psu`. **Save for Xbox** writes a new signed save folder
  (`SAVEGAME.DAT`, `EXTRA`, `TYPE`, `SaveMeta.xbx`) and never overwrites an existing one.

The field diagram approximates the in-game play art. How the CPU runs edited plays still needs
testing in-game.

### Edit formations
Click **Edit formation** above the diagram to move players in the selected play's formation or to
rename it. Drag a player, or type exact spots for the selected player, then click **Back to plays**.
- **Plays are never changed.** Routes and assignments stay attached to each player's slot, so every
  play in the formation simply starts from the new spots.
- **Shifts move with the player.** Each player has a base spot plus two alternate spots the game
  uses for pre-snap shifts and walk-ups; moving a player moves all three by the same amount.
- **Limits.** Players stay in bounds, offense can't line up past the line of scrimmage, and defense
  can't line up on the offense's side.
- **Under center or shotgun.** Moving the QB deeper than 2.7 yd makes it a shotgun formation, and
  moving him up makes it under center: the formation's QB-alignment flag is updated to match, as in
  every stock formation. Plays work from either (stock books share 246 plays between both kinds).
- **Edit, then save.** Players move freely while you rearrange (only the in-bounds and
  line-of-scrimmage limits apply instantly); the panel shows whether the formation is legal yet.
  **Save formation** keeps the changes only if the formation is legal, **Discard changes** goes back
  to the last saved state, and leaving formation mode, switching plays or saving the book saves the
  formation first (an illegal formation is never kept).
- **Real-football eligibility** is checked for normal offensive formations (not kicks or punts).
  A formation can't be saved if it would leave fewer than 7 players on the line, put a player in
  no-man's-land (on neither the line nor a full yard behind it), take a lineman off the line, or
  cover a receiver (a WR, TE, HB or FB on the line with another player outside him is ineligible).
  Formations the game itself built that already break a rule (49 stock ones have a covered
  receiver) stay editable; the panel lists those issues, and edits can't add new ones.
- **Warnings, not blocks,** for overlapping players or a player moved to the other side of the ball
  (flipped plays may then line up oddly).
- **Renaming** (up to 40 characters) writes the new name into the book's unused name space. Existing
  names and every other byte stay as they were.
- **Packages (personnel).** Who lines up in each slot comes from the personnel package picked in the
  play-call screen (the game's "Packages"), not from the formation. The **Packages** panel lists the
  packages the formation can be run with and lets you add existing ones, remove added ones, or pick
  the default (shown on the diagram). Only packages that keep the QB and all five linemen and put an
  eligible player in every skill slot are offered, e.g. *Ace* puts a TE where *Pro* has the FB, and
  *Kings* puts a WR there. Packages themselves, plays and other formations are never changed, and no
  new package is created.
- A formation is shared by every play in it, so a move shows up in all of them. **Reset formation**
  restores its spots, name and packages exactly.

### Swap the whole defense (e.g. 4-3 to 3-4)
In the **Defense** view, **Swap defense…** replaces the book's whole defense with another team's:
drop the donor team's book (a 3-4 team such as PIT, BAL or SD to switch a 4-3 book to 3-4), review
what will change, and confirm.
- It copies the donor's defensive formations, personnel packages, calls and default defensive
  audibles exactly, the same way the game's own playbook editor copies a formation from another team
  (checked against a book the game itself edited). Formations are matched by name (Nickel to Nickel…)
  and base to base (4-3 to 3-4).
- The donor's defense is written into the book's **existing** defensive formation, package and play
  slots, because the base defense can't be removed and books sit near the 270-play limit. No formation,
  package or play is added. If the donor has more calls than fit, some are left out (only blitzes and
  coverages a single formation uses, never audibles; every formation keeps a front and a coverage), and
  the window lists them.
- The offense, special teams and everything else stay byte-for-byte the same; every play must pass the
  game's play check, and the step pool is rebuilt with identical chains shared, as the game does.
- Formations without a match stay as they are (e.g. BUF's 3-2 and 3-3), unless they share calls with
  the formations being replaced, in which case the swap is refused. A donor whose 3-4 still runs 4-3
  calls (converted by another tool) is flagged.
- **Undo defense swap** restores the book until you close it.

## Compare
Load any two of `.max`, `.psu`, `SAVEGAME.DAT` or a raw playbook. It shows differences per table
(formations, plays, route nodes, names, ...) and marks the expected console-specific header bytes.

## Tests
`npm test` runs both suites:
- `tests/run-tests.js` checks conversion. Re-packing the retail PS2 sample reproduces every file
  inside it byte-for-byte, and the bundled Xbox samples convert with output checksums that verify.
- `tests/edit-tests.js` checks the play editor:
  - every play passes the game check, and every step re-encodes exactly
  - private copies, reset, and refused edits behave as described above
  - 400 random edits each change only their own play
  - Xbox signing matches retail saves

## Files
- `electron/main.js`: desktop window, native dialogs, file reads and writes
- `electron/icon.png`: app and exe icon (512×512 square crop of the 2K5 cover)
- `electron/preload.js`: the small `window.porter` API the page uses when running as the desktop app
- `index.html`, `js/app.js`: the user interface (uses `window.porter` when present, browser downloads otherwise)
- `js/editor-ui.js`: the Edit playbook tab (play browser, field diagram, step editor)
- `js/defenseswap.js`: swapping a book's whole defense for another team's
- `js/bookedit.js`: reads formations/plays/steps; applies edits with private copies, reset, validation
- `js/playcodec.js`: step decoding/encoding, the game's play check, play art (ported from
  2k-football-mod-tools `nfl2k5_play_codec.py`, MIT)
- `js/playbook.js`: playbook layout, validation, comparison
- `js/saves.js`: Xbox metadata and save signing, PS2 `.max`/`.psu` read and write, CRC32
- `js/lzari.js`: LZARI compression (AR MAX)
- `js/assets.js`: PS2 save icon taken from a retail playbook save
