#!/usr/bin/env python3
"""Copy the patched tmon source into this plugin's vendor directory.

The plugin ships its own tmon so users install nothing. That copy is derived
from a checkout of https://github.com/cy745/tmon with the session patch applied,
and it is 58 MB before pruning -- mostly `.pdb` debug symbols that no runtime
needs. This script copies only what the runtime loads.

Usage:
    python scripts/vendor-tmon.py --source E:/tmon-src

The source tree must already be built: `dist/cli.js` from `npm run build` and
`web/dist` from `npm run build` inside `web/`.
"""
import argparse
import os
import shutil
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Files the CLI reads at runtime, plus the licence the MIT terms require.
TOP_FILES = ("package.json", "LICENSE", "README.zh-CN.md", "CHANGELOG.md")

# Directories copied whole, minus anything pruned below.
TOP_DIRS = ("bin", "dist", "web/dist")

# Runtime dependencies; tmon bundles the rest.
DEPENDENCIES = ("node-pty", "ws", "iconv-lite", "nan")

SKIP_DIRS = {".git", "test", "tests", "__tests__", "docs", "doc", "coverage", ".github"}
SKIP_SUFFIXES = (".pdb", ".map", ".ts", ".tsbuildinfo", ".md", ".markdown", ".o", ".obj")
KEEP_SUFFIXES = (".node", ".dll", ".exe", ".js", ".json", ".cjs", ".mjs", ".wasm")


def should_copy(name, path):
    """Whether one file inside the vendored tree belongs in the package."""
    if os.path.isdir(path):
        return name not in SKIP_DIRS
    lower = name.lower()
    if lower.endswith(".d.ts") or lower.endswith(".d.mts") or lower.endswith(".d.cts"):
        return False
    if lower.endswith(SKIP_SUFFIXES):
        return False
    return True


def copy_tree(source, target):
    """Copy a directory applying `should_copy`, and report how much was dropped."""
    copied = 0
    for root, directories, files in os.walk(source):
        directories[:] = [d for d in directories if d not in SKIP_DIRS]
        relative = os.path.relpath(root, source)
        destination = os.path.join(target, relative) if relative != "." else target
        os.makedirs(destination, exist_ok=True)
        for name in files:
            if not should_copy(name, os.path.join(root, name)):
                continue
            shutil.copy2(os.path.join(root, name), os.path.join(destination, name))
            copied += 1
    return copied


def size_of(path):
    """Total bytes under a directory."""
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return total


def main():
    """Run the vendor sync."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, help="built tmon checkout")
    parser.add_argument("--dry-run", action="store_true", help="report without writing")
    arguments = parser.parse_args()

    source = os.path.abspath(arguments.source)
    if not os.path.isdir(source):
        sys.exit(f"not a directory: {source}")

    cli = os.path.join(source, "dist", "cli.js")
    if not os.path.isfile(cli):
        sys.exit(f"missing {cli} -- build tmon first (npm run build)")

    web_index = os.path.join(source, "web", "dist", "index.html")
    if not os.path.isfile(web_index):
        sys.exit(f"missing {web_index} -- build the web UI first (cd web && npm run build)")

    target = os.path.join(REPO, "vendor", "tmon")
    if os.path.isdir(target) and not arguments.dry_run:
        shutil.rmtree(target)

    if arguments.dry_run:
        print(f"would copy from {source} to {target}")
        return

    os.makedirs(target, exist_ok=True)
    for name in TOP_FILES:
        path = os.path.join(source, name)
        if os.path.isfile(path):
            shutil.copy2(path, os.path.join(target, name))

    total = 0
    for name in TOP_DIRS:
        path = os.path.join(source, name)
        if os.path.isdir(path):
            total += copy_tree(path, os.path.join(target, name))

    modules = os.path.join(source, "node_modules")
    os.makedirs(os.path.join(target, "node_modules"), exist_ok=True)
    for dependency in DEPENDENCIES:
        path = os.path.join(modules, dependency)
        if os.path.isdir(path):
            total += copy_tree(path, os.path.join(target, "node_modules", dependency))

    print(f"copied {total} files")
    print(f"vendor/tmon is {size_of(target) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
