#!/usr/bin/env python3
"""Install/uninstall @royenheart/dsh-plugin-mcp-support into a dsh profile.

The package is a dsh BUNDLE: its `cordis.patch.yml` inserts its own host row
(id `mcp-support`), and package.json declares `dsh.bundle.patch` pointing at
it. Installing therefore requires only:

1. a symlink of the package into the profile node_modules,
2. adding it to the profile dsh.profile.bundles list (plus a link: dependency).

The profile's own `cordis.patch.yml` is never modified.

Usage:
    python3 install.py install [--profile web] [--home ~/.dsh]
    python3 install.py uninstall [--profile web] [--home ~/.dsh]

Requires only the Python standard library.
"""

import argparse
import json
import os
import sys
from pathlib import Path

PACKAGE = "@royenheart/dsh-plugin-mcp-support"

# Bare runtime imports of the built host bundle (`lib/index.js`). Each must
# resolve when dsh imports the package through its profile symlink, i.e. from
# this checkout's node_modules (Node realpaths the symlink).
RUNTIME_PEERS = ("dsh-settings", "schemastery", "dsh-mcp-client")


def repo_root() -> Path:
    return Path(__file__).resolve().parent


def profile_dir(home: str, profile: str) -> Path:
    return Path(home).expanduser() / "profiles" / profile


def node_modules_pkg(profile: Path) -> Path:
    return profile / "node_modules" / PACKAGE


def shared_node_modules(home: str) -> Path:
    """The shared profile module fallback tree (`profiles/node_modules`)."""
    return Path(home).expanduser() / "profiles" / "node_modules"


def read_json(path: Path) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, data: dict) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def ensure_profile(profile: Path) -> None:
    manifest = profile / "package.json"
    if not manifest.exists():
        raise SystemExit(
            "profile manifest not found: " + str(manifest)
            + " - initialize the profile first (dsh plugin add)"
        )


def ensure_link(link: Path, target: Path) -> None:
    """Create/replace a symlink to `target`; refuse to clobber real paths."""
    link.parent.mkdir(parents=True, exist_ok=True)
    if link.is_symlink():
        if Path(os.readlink(link)).resolve() == target.resolve():
            return
        link.unlink()
    elif link.exists():
        raise SystemExit("refusing to overwrite existing path: " + str(link))
    link.symlink_to(target, target_is_directory=True)


def ensure_runtime_peer_links(root: Path, home: str) -> None:
    """Mirror the profile module tree's harness peers into this checkout.

    The loader imports the package through the profile symlink, and Node
    resolves bare specifiers from the package's REAL path (this checkout), so
    its node_modules must see the same harness packages. Existing workspace
    links (dev-time setup) are deliberately left untouched.
    """
    shared_scope = shared_node_modules(home) / "@deepseek-ai"
    local_scope = root / "node_modules" / "@deepseek-ai"
    for name in RUNTIME_PEERS:
        link = local_scope / name
        if link.exists() or link.is_symlink():
            continue
        source = shared_scope / name
        if not source.exists():
            raise SystemExit(
                "required harness package missing from the shared profile modules: "
                + str(source)
                + " (run `dsh plugin add @deepseek-ai/" + name + "` first)"
            )
        target = Path(os.readlink(source)).resolve() if source.is_symlink() else source.resolve()
        ensure_link(link, target)


def install(args: argparse.Namespace) -> None:
    profile = profile_dir(args.home, args.profile)
    ensure_profile(profile)

    root = repo_root()
    if not (root / "lib" / "index.js").exists():
        raise SystemExit(
            "built bundle missing - run `npm run build` (tsdown) first"
        )
    ensure_runtime_peer_links(root, args.home)

    # 1. Symlink the package into the profile node_modules (idempotent).
    target = root
    link = node_modules_pkg(profile)
    link.parent.mkdir(parents=True, exist_ok=True)
    if link.is_symlink() or link.exists():
        if link.is_symlink() and Path(os.readlink(link)) == target:
            print("already linked:", link)
        else:
            raise SystemExit("refusing to overwrite existing path: " + str(link))
    else:
        link.symlink_to(target, target_is_directory=True)
        print("linked:", link, "->", target)

    # 2. Add the dependency + bundle entry to the profile manifest. The
    #    bundle's own cordis.patch.yml provides the loader row, so the
    #    profile's cordis.patch.yml is untouched.
    manifest_path = profile / "package.json"
    data = read_json(manifest_path)
    deps = data.setdefault("dependencies", {})
    if PACKAGE not in deps:
        deps[PACKAGE] = "link:" + str(target)
        print("added dependency:", PACKAGE)
    else:
        print("dependency already present:", PACKAGE)

    dsh = data.setdefault("dsh", {})
    prof = dsh.setdefault("profile", {})
    bundles = prof.setdefault("bundles", [])
    if PACKAGE not in bundles:
        bundles.append(PACKAGE)
        print("added bundle:", PACKAGE)
    else:
        print("bundle already present:", PACKAGE)

    write_json(manifest_path, data)
    print("installed into profile", repr(args.profile), "at", profile)


def uninstall(args: argparse.Namespace) -> None:
    profile = profile_dir(args.home, args.profile)
    manifest_path = profile / "package.json"

    link = node_modules_pkg(profile)
    if link.is_symlink():
        link.unlink()
        print("removed link:", link)
    elif link.exists():
        print("skipping non-symlink path:", link)
    else:
        print("no link present:", link)

    if manifest_path.exists():
        data = read_json(manifest_path)
        deps = data.get("dependencies", {})
        if PACKAGE in deps:
            del deps[PACKAGE]
            print("removed dependency:", PACKAGE)
        bundles = data.get("dsh", {}).get("profile", {}).get("bundles", [])
        if PACKAGE in bundles:
            bundles.remove(PACKAGE)
            print("removed bundle:", PACKAGE)
        write_json(manifest_path, data)

    print("uninstalled from profile", repr(args.profile), "at", profile)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Install/uninstall the mcp-support dsh plugin"
    )
    parser.add_argument("command", choices=["install", "uninstall"])
    parser.add_argument("--profile", default="web", help="dsh profile name (default: web)")
    parser.add_argument(
        "--home",
        default=os.environ.get("DSH_HOME", "~/.dsh"),
        help="dsh home (default: $DSH_HOME or ~/.dsh)",
    )
    args = parser.parse_args()

    if args.command == "install":
        install(args)
    else:
        uninstall(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
