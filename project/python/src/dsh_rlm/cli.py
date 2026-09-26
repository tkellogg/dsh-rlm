"""PyPI-owned launcher for the version-matched DSH RLM application bundle."""

from __future__ import annotations

import contextlib
import hashlib
import importlib.metadata
import json
import os
import platform
import posixpath
import re
import shutil
import stat
import sys
import tarfile
import tempfile
import time
import urllib.request
from pathlib import Path, PurePosixPath

SOURCE_VERSION = "0.1.2"
RELEASE_URL = "https://github.com/tkellogg/dsh-rlm/releases/download"
DOWNLOAD_TIMEOUT = 30
DOWNLOAD_DEADLINE = 600
MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024
MAX_EXTRACTED_BYTES = 4 * 1024 * 1024 * 1024
MAX_MEMBERS = 200_000
LOCK_TIMEOUT = 2 * DOWNLOAD_DEADLINE + 60
UPDATE_HELP = "Update with `uvx --upgrade dsh-rlm` or `uv tool upgrade dsh-rlm`."
HELP = """DSH RLM — Python-native agents

Usage: uvx dsh-rlm [Web options]
       dsh-rlm setup [Web options]
       dsh-rlm doctor
       dsh-rlm --version

Install: uv tool install dsh-rlm
Web options: --port NUMBER, --no-open, --host ADDRESS, --trusted-host HOST
Runs in the current directory. State: DSH_RLM_HOME or ~/.local/share/dsh-rlm/user.
The first launch downloads a version-matched Node/application bundle from GitHub.
Help, version, and doctor never download. Python comes from this Python environment.
""" + UPDATE_HELP


class LauncherError(Exception):
    """An actionable launcher failure, without an implementation traceback."""


def package_version() -> str:
    try:
        value = importlib.metadata.version("dsh-rlm")
    except importlib.metadata.PackageNotFoundError:
        value = SOURCE_VERSION
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+[a-zA-Z0-9.+-]*", value):
        raise LauncherError(f"Invalid package version: {value!r}")
    return value


def platform_tag() -> str:
    system = platform.system().lower()
    machine = platform.machine().lower()
    arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64", "amd64": "x64"}.get(machine)
    if system not in {"darwin", "linux"} or arch is None:
        raise LauncherError(f"Unsupported platform: {system}-{machine}; supported: macOS/Linux arm64/x64")
    return f"{system}-{arch}"


def cache_root() -> Path:
    base = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache").expanduser()
    if not base.is_absolute():
        raise LauncherError("XDG_CACHE_HOME must be an absolute path")
    return base / "dsh-rlm" / "releases"


def _private_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise LauncherError(f"Cache must be an owned, non-symlink directory: {path}")
    path.chmod(0o700)


@contextlib.contextmanager
def _install_lock(path: Path):
    import fcntl

    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise LauncherError(f"Unsafe cache lock: {path}")
        deadline = time.monotonic() + LOCK_TIMEOUT
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise LauncherError("Timed out waiting for another dsh-rlm install") from None
                time.sleep(0.05)
        yield
    finally:
        os.close(fd)


class _HTTPSRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not newurl.startswith("https://"):
            raise LauncherError("Refusing a non-HTTPS release redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _download(url: str, destination: Path, limit: int) -> None:
    if not url.startswith("https://"):
        raise LauncherError("Release downloads require HTTPS")
    opener = urllib.request.build_opener(_HTTPSRedirects())
    request = urllib.request.Request(url, headers={"User-Agent": "dsh-rlm-python-launcher"})
    deadline = time.monotonic() + DOWNLOAD_DEADLINE
    with opener.open(request, timeout=DOWNLOAD_TIMEOUT) as response, destination.open("xb") as out:
        length = response.headers.get("Content-Length")
        if length and int(length) > limit:
            raise LauncherError("Release download exceeds size limit")
        total = 0
        while True:
            if time.monotonic() > deadline:
                raise LauncherError("Release download exceeded time limit")
            chunk = response.read1(64 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > limit:
                raise LauncherError("Release download exceeds size limit")
            out.write(chunk)


def _verify_checksum(archive: Path, sums: Path, asset: str) -> None:
    matches = []
    for line in sums.read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"([a-fA-F0-9]{64})  ?\*?(.+)", line)
        if match and match[2] == asset:
            matches.append(match[1].lower())
    if len(matches) != 1:
        raise LauncherError(f"SHA256SUMS must contain exactly one checksum for {asset}")
    digest = hashlib.sha256()
    with archive.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != matches[0]:
        raise LauncherError(f"SHA256 checksum mismatch for {asset}")


def _member_path(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or "\\" in name:
        raise LauncherError(f"Unsafe archive path: {name!r}")
    return path


def _extract(archive: Path, destination: Path) -> None:
    """Never extract through links; permit npm's internal relative symlinks."""
    links = []
    seen = set()
    total = 0
    with tarfile.open(archive, "r:gz") as tar:
        for count, member in enumerate(tar, 1):
            if count > MAX_MEMBERS:
                raise LauncherError("Archive has too many entries")
            relative = _member_path(member.name)
            if relative == PurePosixPath(".") and member.isdir():
                continue
            if relative == PurePosixPath(".") or relative in seen:
                raise LauncherError(f"Duplicate or empty archive path: {member.name}")
            seen.add(relative)
            target = destination.joinpath(*relative.parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True, mode=0o700)
            elif member.isfile():
                total += member.size
                if member.size < 0 or total > MAX_EXTRACTED_BYTES:
                    raise LauncherError("Extracted archive exceeds size limit")
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                source = tar.extractfile(member)
                if source is None:
                    raise LauncherError(f"Unreadable archive member: {member.name}")
                with source, target.open("xb") as out:
                    shutil.copyfileobj(source, out, 1024 * 1024)
                target.chmod(0o700 if member.mode & 0o111 else 0o600)
            elif member.issym():
                link = member.linkname
                normalized = posixpath.normpath(posixpath.join(str(relative.parent), link))
                if not link or link.startswith("/") or "\\" in link or normalized == ".." or normalized.startswith("../"):
                    raise LauncherError(f"Unsafe archive symlink: {member.name} -> {link}")
                links.append((target, link))
            else:
                raise LauncherError(f"Unsupported archive entry: {member.name}")
    # Files/directories are complete before any symlink exists. A link can never
    # be an extraction parent, regardless of tar entry order.
    for target, _ in links:
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    for target, link in links:
        if target.exists() or target.is_symlink():
            raise LauncherError(f"Archive symlink overlaps an extraction directory: {target}")
        target.symlink_to(link)
    for target, _ in links:
        try:
            resolved = target.resolve()
        except RuntimeError as exc:
            raise LauncherError(f"Cyclic archive symlink: {target}") from exc
        if not resolved.is_relative_to(destination.resolve()):
            raise LauncherError(f"Archive symlink escapes release: {target}")


def validate_release(root: Path, version: str) -> None:
    required = ("runtime/node/bin/node", "app/node_modules/@deepseek-ai/dsh/lib/bin.js",
                "app/rlm.patch.yml", "launcher/cli.mjs", "release.json")
    for name in required:
        path = root / name
        if not path.is_file() or not path.resolve().is_relative_to(root.resolve()):
            raise LauncherError(f"Incomplete or unsafe release: {path}")
    manifest = json.loads((root / "release.json").read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or manifest.get("version") != version:
        raise LauncherError(f"Release version does not match Python package {version}")
    if not os.access(root / "runtime/node/bin/node", os.X_OK):
        raise LauncherError("Bundled Node is not executable")


def application_dir(version: str, *, install: bool) -> Path:
    override = os.environ.get("DSH_RLM_APP_DIR")
    if override:
        root = Path(override).expanduser().resolve()
        validate_release(root, version)
        return root
    tag = platform_tag()
    cache = cache_root()
    root = cache / f"{version}-{tag}"
    if root.exists():
        _private_directory(cache.parent)
        _private_directory(cache)
        _private_directory(root)
        validate_release(root, version)
        return root
    if not install:
        raise LauncherError("Application bundle not installed; run `uvx dsh-rlm` or `dsh-rlm setup` first")
    _private_directory(cache.parent)
    _private_directory(cache)
    with _install_lock(cache / f".{version}-{tag}.lock"):
        if root.exists():
            _private_directory(root)
            validate_release(root, version)
            return root
        asset = f"dsh-rlm-v{version}-{tag}.tar.gz"
        url = f"{RELEASE_URL}/v{version}"
        with tempfile.TemporaryDirectory(prefix=f".{version}-{tag}-", dir=cache) as temp:
            stage = Path(temp)
            archive, sums = stage / asset, stage / "SHA256SUMS"
            print(f"dsh-rlm: fetching checksums for {version} ({tag})...", file=sys.stderr)
            _download(f"{url}/SHA256SUMS", sums, 1024 * 1024)
            print(f"dsh-rlm: downloading {asset}...", file=sys.stderr)
            _download(f"{url}/{asset}", archive, MAX_ARCHIVE_BYTES)
            print("dsh-rlm: verifying SHA256 checksum...", file=sys.stderr)
            _verify_checksum(archive, sums, asset)
            bundle = stage / "bundle"
            bundle.mkdir(mode=0o700)
            print("dsh-rlm: extracting application bundle...", file=sys.stderr)
            _extract(archive, bundle)
            validate_release(bundle, version)
            os.replace(bundle, root)
    return root


def _validate_args(args: list[str]) -> None:
    web = args[1:] if args and args[0] == "setup" else args
    i = 0
    while i < len(web):
        if web[i] in {"--no-open", "--dump-config"}:
            i += 1
        elif web[i] in {"--port", "--host", "--trusted-host"} and i + 1 < len(web) and not web[i + 1].startswith("--"):
            i += 2
        else:
            raise LauncherError(f"Unsupported command or Web option: {web[i]}; use --help")


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    try:
        if args and args[0] in {"--help", "-h", "help"}:
            print(HELP)
            return 0
        version = package_version()
        if args == ["--version"]:
            print(f"dsh-rlm {version}")
            return 0
        if args and args[0] == "update":
            print(UPDATE_HELP)
            return 0
        doctor = args == ["doctor"]
        if not doctor:
            _validate_args(args)
        root = application_dir(version, install=not doctor)
        env = dict(os.environ)
        # uv owns Python and its dependencies. Never use the bundle's Python,
        # and do not resolve the venv symlink (which would lose its environment).
        env["DSH_RLM_PYTHON"] = sys.executable
        node = str(root / "runtime/node/bin/node")
        os.execve(node, [node, str(root / "launcher/cli.mjs"), *args], env)
        return 0  # only reached by test doubles
    except (LauncherError, OSError, ValueError, EOFError, tarfile.TarError) as exc:
        print(f"dsh-rlm: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
