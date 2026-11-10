# CinnaSpot

Spotlight-inspired launcher for Cinnamon.

## Main UI

- Opens directly with focus on the search field.
- Empty state shows a **Show Opened Windows** action.
- `Tab` toggles the opened-window view without changing the persistent setting.
- `Esc` closes CinnaSpot.
- `Up/Down` navigates results.
- `Enter` activates the selected result.

## Search

The global `Max Search Results` setting is used by applications, files and scripts.

Opened windows additionally respect `Max Opened Window Results`, so the effective window limit is the smaller of the two.

## Script runner

Examples:

```text
sh
sh 
sh docker
sh backup
```

`sh` / `sh ` lists scripts, but is capped by `Max Search Results`.

The implementation also guards against async search race conditions. If the user types another query before an earlier script search completes, the old result is discarded. Script paths and files are deduplicated by path.

## Important note about thumbnails

Cinnamon's Meta.Window API does not provide a stable cross-version live thumbnail API that can safely be used across all targeted Cinnamon versions. The "Show Window Preview" option therefore uses an app-icon preview card rather than a live screenshot thumbnail.

## Installation

Copy the extension directory to:

```text
~/.local/share/cinnamon/extensions/cinnaspot@ansori/
```

Then enable it from Cinnamon Extensions.

## Settings

Run:

```text
cinnamon-settings extensions
```

and open CinnaSpot settings.
