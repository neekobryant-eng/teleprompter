# Teleprompter (working title)

A teleprompter web app for the Galaxy Tab S7. Plain HTML, CSS and JavaScript with no dependencies and no backend. Scripts live in the tablet's browser storage (IndexedDB). The full plan is in `SPEC.md`, which stays on the laptop and isn't in the repository.

**Live at https://neekobryant-eng.github.io/teleprompter/**

**Status:** Phase 1 (core prompter) and Phase 2 (install and offline) are built and published to GitHub Pages.

## Run it

1. Plug the tablet in over USB (USB debugging on, laptop already allowed).
2. Double-click **`dev.cmd`**. It runs `adb reverse tcp:8080 tcp:8080` and starts the server.
3. On the tablet, open Chrome to **http://localhost:8080**.

Leave the `dev.cmd` window open while testing. Close it (or press Ctrl+C) to stop the server.

Manual equivalent:

```
%USERPROFILE%\Downloads\platform-tools-latest-windows\platform-tools\adb.exe reverse tcp:8080 tcp:8080
node server.mjs
```

Re-run `adb reverse` (or `dev.cmd`) whenever you unplug and replug the tablet.

**See errors from the tablet:** in Chrome on the laptop, open `chrome://inspect/#devices` and click **inspect** under the tablet's tab. Errors also pop up as a toast in the app.

## Install and offline

**Install:** tap **Install app** in the library (or Chrome's ⋮ menu → *Install app*). The app gets a home-screen icon and opens full screen, with no address bar.

**Offline:** the first time the app loads, it keeps a copy of itself on the tablet (the library footer then says *Works offline*). After that it opens with Wi-Fi off, and every script plays. Scripts were always stored on the tablet.

**Updates:** whenever the app opens online, it checks the site for changed files in the background. If anything changed, it downloads the whole new version and the library shows **Update ready · Reload**. Nothing to bump by hand.

**Scripts belong to the address they were made on.** Chrome keeps storage separate per site, so scripts in `localhost:8080` don't appear in the GitHub Pages copy, and the reverse. To move them: **Back up all scripts** on one, then **Restore from backup** on the other.

During development (`localhost`) the app asks the laptop for the latest files first, so a reload always shows new code. If the server doesn't answer within a second, it opens from the saved copy.

## Publish to GitHub Pages

The app is published at **https://neekobryant-eng.github.io/teleprompter/** from the public repository [neekobryant-eng/teleprompter](https://github.com/neekobryant-eng/teleprompter). Free Pages needs a public repository; scripts never leave the tablet. GitHub Pages serves the `main` branch as it is (`.nojekyll` turns off its site builder), so there's no build step.

**To publish a change:** double-click **`publish.cmd`**. It shows what changed, asks for a one-line description, commits and pushes. Or, in a terminal in this folder:

```
git add -A
git commit -m "Describe the change"
git push
```

The site updates about a minute after the push. The tablet picks it up the next time the app opens online, and the library shows **Update ready · Reload**.

**First time on the tablet:** open the address in Chrome, tap **Install app**, then move your scripts across with backup and restore (see above).

`SPEC.md` is never published (it's in `.gitignore`): it includes the tablet's serial number and laptop folder paths. Git and the GitHub CLI (`gh`) are installed and signed in to the `neekobryant-eng` account.

## Using it

**Library:** New script, Paste as new (reads the clipboard), Import .txt / .md (several at once), and a ⋯ menu on each script for Rename, Duplicate and Delete. *Back up all scripts* saves one JSON file to Downloads; *Restore from backup* adds scripts from it (a script already on the tablet is only replaced if the backup copy is newer).

**Editor:** saves as you type. The title is optional; without one, the first line is used.

**Prompter gestures** (they work anywhere on the screen; controls stay hidden):

| Gesture | Action | Key |
| --- | --- | --- |
| Tap middle third | Play / pause | Space |
| Tap right third | Faster, 5% | → |
| Tap left third | Slower, 5% | ← |
| Swipe up / down | Move text forward / back | ↓ / ↑ |
| Two-finger swipe left / right | Next / previous section | Page Down / Page Up |
| Long press | Controls overlay | Esc |
| Double-tap middle | Restart from the top, after a confirmation | Home |

The tap zones use the physical screen, so in mirror mode the right side is still "faster".

**Controls overlay:** speed, font size, line spacing, side margins, reading-line position, mode (Full screen / Glass rig), theme (dark / light / high contrast), mirror left–right, flip upside down, countdown on/off, jump to section, full screen, edit, exit. Every setting is saved with the script. New scripts start with the settings you used last.

**Glass rig mode** switches on the left–right mirror and high contrast in one tap. Switching back to Full screen restores your previous theme.

### Script marks in Phase 1

| You type | Shows as |
| --- | --- |
| `## Opening` | Section start, shown as a small divider; two-finger swipes jump between these |
| `// note to self` (whole line) | Hidden on the prompter |
| Blank line | New paragraph |

Other marks (`*emphasis*`, `[PAUSE]`, `[SLOW]…[/SLOW]`, `[BREATHE]`) show as plain text until Phase 3.

## How speed works

Speed is a percentage of 140 words per minute. The app measures how much screen height your text takes and converts that to pixels per second, so 100% reads at about the same pace whatever the font size, margins or orientation. Movement uses `requestAnimationFrame` and `translate3d` with fractional pixels, timed in seconds, so it's the same at 60 Hz and 120 Hz. Starts, stops and speed changes ease in over about 0.15 s.

**60 Hz vs 120 Hz on the Tab S7.** Measured on the tablet (Nov 4): with Motion smoothness set to Adaptive, Samsung runs Chrome at 120 Hz only for about 3.3 seconds after each touch, then drops to 60 Hz even while the page draws every frame. So the hands-off scroll runs at 60 Hz. Over a 5 min 44 s run it was evenly paced: 20,618 frames, 4 late, none backwards, speed within ±1%. Keeping a page drawing every frame does not change this (tried and removed), and a web page has no way to ask for 120 Hz. The code needs no change if Samsung or Chrome allow it later.

## Files

| File | What it does |
| --- | --- |
| `index.html` | The three screens: library, editor, prompter, plus the controls overlay |
| `styles.css` | All styling; prompter themes are CSS variables on `.pr-stage` |
| `app.js` | Everything else: storage, editor, scroll engine, gestures, keyboard, overlay, wake lock, install and update buttons |
| `sw.js` | Service worker: keeps the offline copy and checks for updates. If you add a file the app loads, add it to `SHELL` in here |
| `manifest.webmanifest` | App name, icons, opens full screen |
| `icons/` | App icons; redraw them with `node tools/make-icons.mjs` |
| `.nojekyll` | Tells GitHub Pages to serve the files as they are |
| `server.mjs` | Dev server for localhost:8080 with caching off (development only) |
| `dev.cmd` | Links the tablet over USB and starts the server (development only) |
| `publish.cmd` | Commits and pushes, which publishes the site |
| `SPEC.md` | The spec (laptop only, not in the repository) |

## Phase 1 checklist (run on the tablet)

- [ ] Paste a 2-page script, save it, close Chrome, reopen: script and its settings are still there
- [x] Scroll runs 5 minutes with no stutter and the screen never dims (measured Nov 4, at 60 Hz; see above)
- [ ] Every gesture in the touch table works, including in mirror mode (taps, swipes and long-press checked with real touch; mirror, double-tap and two-finger swipes checked in the browser)

## Phase 2 checklist (run on the tablet)

- [x] App installs to the home screen and opens full screen (Nov 4, from the GitHub Pages address: no status bar, address bar or navigation bar; the overlay's full-screen button is hidden because it isn't needed)
- [ ] With Wi-Fi off, the app opens and every script plays (checked Nov 4 on localhost with the server stopped, and on the GitHub Pages copy with the page's network cut: both opened from the saved copy and played. Still to do: the installed app with Wi-Fi actually off)
