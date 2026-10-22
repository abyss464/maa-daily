#!/bin/sh
# Keep automation's Windows state separate while sharing the installed game files.
set -eu

source_prefix=$(realpath -- "${1:?Usage: prepare-prefix.sh LUTRIS_PREFIX}")
data_dir=${MAA_DAILY_DATA_DIR:-"$HOME/.local/share/maa-daily"}
target_prefix=${MAA_DAILY_ENDFIELD_PREFIX:-"$data_dir/endfield-prefix"}
if [ -e "$target_prefix" ]; then
    printf '%s\n' "The automation prefix already exists: $target_prefix" >&2
    exit 1
fi
games='drive_c/Program Files/Hypergryph Launcher/games'
if [ ! -d "$source_prefix/$games" ]; then
    printf '%s\n' 'The source prefix does not contain the installed games.' >&2
    exit 1
fi
mkdir -p -- "$data_dir"
work_prefix=$(mktemp -d "$data_dir/.endfield-prefix.XXXXXX")
trap 'if [ -d "$work_prefix" ]; then gio trash -- "$work_prefix"; fi' EXIT
cp -a --reflink=always -- "$source_prefix/." "$work_prefix/"
gio trash -- "$work_prefix/$games"
ln -s -- "$source_prefix/$games" "$work_prefix/$games"
if [ -e "$work_prefix/drive_c/XXMI Launcher" ]; then
    gio trash -- "$work_prefix/drive_c/XXMI Launcher"
fi
chmod 700 -- "$work_prefix"
mv -- "$work_prefix" "$target_prefix"
printf '%s\n' "Prepared the automation prefix: $target_prefix"
