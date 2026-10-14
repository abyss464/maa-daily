#!/bin/sh
# Builds the folder maa-daily runs MaaEnd from, out of links into MaaEnd's install/ (our branch,
# ~/Code/vendor/MaaEnd, built with `uv run setup-workspace` and `uv run build-and-install`).
#
# MaaPiCli takes the project from the folder of its own libraries, and MaaEnd's agents look for
# the libraries under <project>/maafw: so the runtime's maafw/ holds links to the libraries and to
# the project's files side by side, and a link to itself. Its config/ and debug/ are real folders,
# written by the CLI. Run again after rebuilding MaaEnd.
set -eu

src="${1:-$HOME/Code/vendor/MaaEnd/install}"
run="${MAA_DAILY_DATA_DIR:-$HOME/.local/share/maa-daily}/maaend-runtime"
lib=$(readlink -f "$src/maafw")
[ -f "$lib/MaaPiCli" ] || { echo "no MaaPiCli under $src/maafw" >&2; exit 1; }
# The workspace setup unpacks the framework from a zip, which drops the executable bit.
chmod +x "$lib/MaaPiCli"

mkdir -p "$run/maafw/config" "$run/maafw/debug"
find "$run/maafw" -maxdepth 1 -type l -delete
for f in "$lib"/*; do ln -s "$f" "$run/maafw/$(basename "$f")"; done
for f in interface.json resource resource_linux agent tasks locales data; do
  ln -s "$(readlink -f "$src/$f")" "$run/maafw/$f"
done
ln -s . "$run/maafw/maafw"
echo "MaaEnd runtime at $run/maafw from $src"
