#!/bin/bash
# Copy HOOK.md files from src/hooks/bundled/ to dist/bundled/
# The build system only compiles .ts -> .js but doesn't copy .md assets
for hook_dir in src/hooks/bundled/*/; do
    name=$(basename "$hook_dir")
    src_md="$hook_dir/HOOK.md"
    dest_dir="dist/bundled/$name"
    if [ -f "$src_md" ] && [ -d "$dest_dir" ]; then
        cp "$src_md" "$dest_dir/HOOK.md"
    fi
done
echo "HOOK.md files copied to dist/bundled/"
