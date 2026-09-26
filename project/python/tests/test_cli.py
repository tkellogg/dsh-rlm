"""Offline launcher tests: no release network, package installation, or server."""

import hashlib
import io
import json
import os
import shutil
import stat
import sys
import tarfile
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest

from dsh_rlm import cli

REAL_PLATFORM_TAG = cli.platform_tag
VERSION = "0.1.0"
TAG = "linux-x64"
ASSET = f"dsh-rlm-v{VERSION}-{TAG}.tar.gz"


def make_archive(path, extras=(), version=VERSION):
    files = {
        "runtime/node/bin/node": b"#!/bin/sh\nexit 0\n",
        "app/node_modules/@deepseek-ai/dsh/lib/bin.js": b"// fixture",
        "app/rlm.patch.yml": b"[]\n",
        "launcher/cli.mjs": b"// fixture",
        "release.json": json.dumps({"version": version}).encode(),
    }
    with tarfile.open(path, "w:gz") as tar:
        root = tarfile.TarInfo(".")
        root.type = tarfile.DIRTYPE
        tar.addfile(root)
        for name, content in files.items():
            info = tarfile.TarInfo("./" + name)
            info.size = len(content)
            info.mode = 0o755 if name.endswith("/node") else 0o644
            tar.addfile(info, io.BytesIO(content))
        for name, kind, value in extras:
            info = tarfile.TarInfo(name)
            info.type = kind
            if kind == tarfile.REGTYPE:
                info.size = len(value)
                tar.addfile(info, io.BytesIO(value))
            else:
                info.linkname = value
                tar.addfile(info)
    return path


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))
    monkeypatch.delenv("DSH_RLM_APP_DIR", raising=False)
    monkeypatch.setattr(cli, "platform_tag", lambda: TAG)
    monkeypatch.setattr(cli.importlib.metadata, "version", lambda name: VERSION)
    monkeypatch.setattr(cli.urllib.request, "build_opener", lambda *a: pytest.fail("Unexpected network"))
    monkeypatch.setattr(cli.os, "execve", lambda *a: pytest.fail("Unexpected exec"))


@pytest.fixture
def artifact(tmp_path, monkeypatch):
    archive = make_archive(tmp_path / ASSET, [
        ("app/node_modules/.bin/dsh", tarfile.SYMTYPE, "../@deepseek-ai/dsh/lib/bin.js"),
    ])
    calls = []

    def download(url, destination, limit):
        calls.append(url)
        assert url.startswith(f"{cli.RELEASE_URL}/v{VERSION}/")
        if url.endswith("SHA256SUMS"):
            destination.write_text(f"{hashlib.sha256(archive.read_bytes()).hexdigest()}  {ASSET}\n")
        else:
            assert url.endswith("/" + ASSET)
            shutil.copyfile(archive, destination)

    monkeypatch.setattr(cli, "_download", download)
    return archive, calls


def test_first_install_and_durable_cache(artifact, monkeypatch, tmp_path, capsys):
    archive, calls = artifact
    root = cli.application_dir(VERSION, install=True)
    progress = capsys.readouterr()
    assert progress.out == ""
    for step in ("fetching checksums", "downloading", "verifying SHA256", "extracting"):
        assert step in progress.err
    assert root == tmp_path / "cache/dsh-rlm/releases" / f"{VERSION}-{TAG}"
    assert calls == [f"{cli.RELEASE_URL}/v{VERSION}/SHA256SUMS", f"{cli.RELEASE_URL}/v{VERSION}/{ASSET}"]
    assert stat.S_IMODE(root.stat().st_mode) == 0o700
    assert stat.S_IMODE(root.parent.stat().st_mode) == 0o700
    assert (root / "app/node_modules/.bin/dsh").read_bytes() == b"// fixture"
    assert not (root / "runtime/python").exists()
    archive.unlink()
    monkeypatch.setenv("UV_CACHE_DIR", str(tmp_path / "different-uv-cache"))
    monkeypatch.setenv("DSH_RLM_HOME", str(tmp_path / "user-data"))
    monkeypatch.setattr(cli, "_download", lambda *a: pytest.fail("Cache reuse downloaded"))
    assert cli.application_dir(VERSION, install=True) == root
    assert cli.application_dir(VERSION, install=False) == root


def test_checksum_failure_never_publishes(artifact, monkeypatch):
    original = cli._download

    def corrupt(url, path, limit):
        original(url, path, limit)
        if url.endswith(".tar.gz"):
            with path.open("ab") as out:
                out.write(b"corruption")

    monkeypatch.setattr(cli, "_download", corrupt)
    with pytest.raises(cli.LauncherError, match="checksum mismatch"):
        cli.application_dir(VERSION, install=True)
    assert not (cli.cache_root() / f"{VERSION}-{TAG}").exists()
    assert list(cli.cache_root().iterdir()) == [cli.cache_root() / f".{VERSION}-{TAG}.lock"]


@pytest.mark.parametrize("entries", [
    [("../escape", tarfile.REGTYPE, b"bad")],
    [("/absolute", tarfile.REGTYPE, b"bad")],
    [("link", tarfile.SYMTYPE, "../escape")],
    [("link", tarfile.SYMTYPE, "/tmp/escape")],
    [("link", tarfile.LNKTYPE, "release.json")],
    [("pipe", tarfile.FIFOTYPE, "")],
    [("release.json", tarfile.REGTYPE, b"duplicate")],
    [("link", tarfile.SYMTYPE, "app"), ("link/file", tarfile.REGTYPE, b"bad")],
    [("link", tarfile.SYMTYPE, "app"), ("link/child", tarfile.SYMTYPE, "../release.json")],
    [("a", tarfile.SYMTYPE, "b"), ("b", tarfile.SYMTYPE, "a")],
    [("x", tarfile.SYMTYPE, "."), ("y", tarfile.SYMTYPE, "x/../outside")],
])
def test_rejects_unsafe_archive(tmp_path, entries):
    archive = make_archive(tmp_path / "bad.tar.gz", entries)
    destination = tmp_path / "out"
    destination.mkdir()
    with pytest.raises((cli.LauncherError, OSError)):
        cli._extract(archive, destination)
    assert not (tmp_path / "escape").exists()
    assert not (tmp_path / "outside").exists()


def test_concurrent_install_publishes_once(artifact, monkeypatch):
    _, calls = artifact
    original = cli._download
    entered = threading.Event()
    proceed = threading.Event()

    def held_download(*args):
        entered.set()
        assert proceed.wait(5)
        original(*args)

    monkeypatch.setattr(cli, "_download", held_download)
    with ThreadPoolExecutor(max_workers=4) as pool:
        first = pool.submit(cli.application_dir, VERSION, install=True)
        assert entered.wait(5)
        others = [pool.submit(cli.application_dir, VERSION, install=True) for _ in range(3)]
        assert not (cli.cache_root() / f"{VERSION}-{TAG}").exists()
        proceed.set()
        roots = [f.result(timeout=10) for f in [first, *others]]
    assert len(set(roots)) == 1
    assert len(calls) == 2
    cli.validate_release(roots[0], VERSION)


@pytest.mark.parametrize("args", [[], ["setup", "--port", "4123", "--no-open"], ["doctor"], ["--dump-config"]])
def test_development_override_argv_env_cwd(tmp_path, monkeypatch, args):
    archive = make_archive(tmp_path / "fixture.tar.gz")
    root = tmp_path / "prepared release"
    root.mkdir()
    cli._extract(archive, root)
    monkeypatch.setenv("DSH_RLM_APP_DIR", str(root))
    monkeypatch.setenv("DSH_RLM_HOME", str(tmp_path / "data"))
    monkeypatch.setenv("DSH_RLM_PYTHON", "/wrong/embedded/python")
    monkeypatch.setattr(sys, "executable", "/uv/venv/bin/python")
    cwd = Path.cwd()
    calls = []
    monkeypatch.setattr(cli.os, "execve", lambda *a: calls.append(a))
    assert cli.main(args) == 0
    node, argv, env = calls[0]
    assert node == str(root / "runtime/node/bin/node")
    assert argv == [node, str(root / "launcher/cli.mjs"), *args]
    assert env["DSH_RLM_PYTHON"] == "/uv/venv/bin/python"
    assert env["DSH_RLM_HOME"] == str(tmp_path / "data")
    assert os.environ["DSH_RLM_PYTHON"] == "/wrong/embedded/python"
    assert Path.cwd() == cwd
    assert not cli.cache_root().exists()


@pytest.mark.parametrize("args,code", [(["--help"], 0), (["help"], 0), (["--version"], 0), (["doctor"], 1), (["update"], 0), (["wat"], 1), (["--port"], 1)])
def test_informational_commands_never_download(args, code, capsys):
    assert cli.main(args) == code
    out = capsys.readouterr()
    assert not cli.cache_root().exists()
    if args == ["--version"]:
        assert out.out.strip() == "dsh-rlm 0.1.0"
    if args[0] in {"--help", "help", "update"}:
        assert "uvx --upgrade dsh-rlm" in out.out
        assert "uv tool upgrade dsh-rlm" in out.out
        assert "install.sh" not in out.out


def test_metadata_version_and_source_fallback(monkeypatch):
    monkeypatch.setattr(cli.importlib.metadata, "version", lambda name: "2.3.4")
    assert cli.package_version() == "2.3.4"

    def missing(name):
        raise cli.importlib.metadata.PackageNotFoundError(name)

    monkeypatch.setattr(cli.importlib.metadata, "version", missing)
    import tomllib
    project = Path(__file__).parents[1] / "pyproject.toml"
    assert cli.package_version() == tomllib.loads(project.read_text())["project"]["version"]


def test_mismatched_override_fails_without_network(tmp_path, monkeypatch, capsys):
    root = tmp_path / "release"
    root.mkdir()
    cli._extract(make_archive(tmp_path / "wrong.tar.gz", version="0.2.0"), root)
    monkeypatch.setenv("DSH_RLM_APP_DIR", str(root))
    assert cli.main([]) == 1
    assert "does not match" in capsys.readouterr().err


@pytest.mark.parametrize("headers,body", [({"Content-Length": "11"}, b"x"), ({}, b"x" * 11)])
def test_download_size_limit_and_timeout(tmp_path, monkeypatch, headers, body):
    response = io.BytesIO(body)
    response.headers = headers
    calls = []

    def open_request(request, timeout):
        calls.append(timeout)
        return response

    monkeypatch.setattr(cli.urllib.request, "build_opener", lambda *a: SimpleNamespace(open=open_request))
    with pytest.raises(cli.LauncherError, match="size limit"):
        cli._download("https://github.com/fixture", tmp_path / "download", 10)
    assert calls == [cli.DOWNLOAD_TIMEOUT]


def test_no_http_redirect_or_download(tmp_path):
    with pytest.raises(cli.LauncherError, match="HTTPS"):
        cli._download("http://github.com/fixture", tmp_path / "download", 10)
    with pytest.raises(cli.LauncherError, match="HTTPS"):
        cli._HTTPSRedirects().redirect_request(None, None, 302, "", {}, "http://unsafe")


def test_extraction_size_limit(tmp_path, monkeypatch):
    archive = make_archive(tmp_path / "fixture.tar.gz")
    destination = tmp_path / "out"
    destination.mkdir()
    monkeypatch.setattr(cli, "MAX_EXTRACTED_BYTES", 1)
    with pytest.raises(cli.LauncherError, match="size limit"):
        cli._extract(archive, destination)


@pytest.mark.parametrize("system,machine,expected", [
    ("Darwin", "arm64", "darwin-arm64"),
    ("Darwin", "x86_64", "darwin-x64"),
    ("Linux", "aarch64", "linux-arm64"),
    ("Linux", "AMD64", "linux-x64"),
])
def test_platform_mapping(monkeypatch, system, machine, expected):
    monkeypatch.setattr(cli.platform, "system", lambda: system)
    monkeypatch.setattr(cli.platform, "machine", lambda: machine)
    assert REAL_PLATFORM_TAG() == expected


def test_unsupported_platform(monkeypatch):
    monkeypatch.setattr(cli.platform, "system", lambda: "Windows")
    with pytest.raises(cli.LauncherError, match="Unsupported platform"):
        REAL_PLATFORM_TAG()


@pytest.mark.parametrize("contents", ["", "0" * 64 + "  other.tar.gz\n", ("0" * 64 + "  fixture.tar.gz\n") * 2])
def test_missing_or_duplicate_checksum(tmp_path, contents):
    archive = tmp_path / "fixture.tar.gz"
    archive.write_bytes(b"test")
    sums = tmp_path / "SHA256SUMS"
    sums.write_text(contents)
    with pytest.raises(cli.LauncherError, match="exactly one checksum"):
        cli._verify_checksum(archive, sums, archive.name)


def test_failed_download_can_retry(artifact, monkeypatch):
    original = cli._download
    monkeypatch.setattr(cli, "_download", lambda *a: (_ for _ in ()).throw(TimeoutError("offline")))
    with pytest.raises(TimeoutError):
        cli.application_dir(VERSION, install=True)
    assert not (cli.cache_root() / f"{VERSION}-{TAG}").exists()
    monkeypatch.setattr(cli, "_download", original)
    cli.validate_release(cli.application_dir(VERSION, install=True), VERSION)


def test_symlink_cache_rejected(tmp_path, monkeypatch):
    real = tmp_path / "real"
    real.mkdir()
    cache = tmp_path / "cache"
    cache.mkdir()
    (cache / "dsh-rlm").symlink_to(real, target_is_directory=True)
    with pytest.raises(cli.LauncherError, match="non-symlink"):
        cli.application_dir(VERSION, install=True)


def test_download_deadline(tmp_path, monkeypatch):
    response = io.BytesIO(b"test")
    response.headers = {}
    monkeypatch.setattr(cli.urllib.request, "build_opener", lambda *a: SimpleNamespace(open=lambda *a, **k: response))
    clock = iter([0, cli.DOWNLOAD_DEADLINE + 1])
    monkeypatch.setattr(cli.time, "monotonic", lambda: next(clock))
    with pytest.raises(cli.LauncherError, match="time limit"):
        cli._download("https://github.com/fixture", tmp_path / "download", 10)


@pytest.mark.parametrize("mutation", ["gzip-header", "gzip-truncated", "tar-truncated"])
def test_malformed_archive_is_cli_error_and_retryable(artifact, monkeypatch, capsys, mutation):
    import gzip

    archive, _ = artifact
    good = archive.read_bytes()
    if mutation == "gzip-header":
        archive.write_bytes(b"not gzip")
    elif mutation == "gzip-truncated":
        archive.write_bytes(good[:20])
    else:
        archive.write_bytes(gzip.compress(gzip.decompress(good)[:700]))
    assert cli.main([]) == 1
    assert "Traceback" not in capsys.readouterr().err
    assert not (cli.cache_root() / f"{VERSION}-{TAG}").exists()
    assert len(list(cli.cache_root().iterdir())) == 1  # lock only
    archive.write_bytes(good)
    cli.validate_release(cli.application_dir(VERSION, install=True), VERSION)


@pytest.mark.parametrize("entries", [
    [("a\\b", tarfile.REGTYPE, b"bad")],
    [("a", tarfile.SYMTYPE, "")],
    [("a", tarfile.SYMTYPE, "b\\c")],
    [("a", tarfile.LNKTYPE, "../../outside")],
    [("a", tarfile.CHRTYPE, "")],
    [("a", tarfile.BLKTYPE, "")],
    [("a", tarfile.REGTYPE, b"x"), ("./a", tarfile.REGTYPE, b"y")],
    [("a/b", tarfile.REGTYPE, b"x"), ("a", tarfile.SYMTYPE, "app")],
])
def test_more_malicious_archives_never_publish(artifact, entries):
    archive, _ = artifact
    make_archive(archive, entries)
    assert cli.main([]) == 1
    assert not (cli.cache_root() / f"{VERSION}-{TAG}").exists()
    assert len(list(cli.cache_root().iterdir())) == 1


def test_member_limit_counts_root_and_directories(artifact, monkeypatch):
    monkeypatch.setattr(cli, "MAX_MEMBERS", 5)
    with pytest.raises(cli.LauncherError, match="too many entries"):
        cli.application_dir(VERSION, install=True)
    assert len(list(cli.cache_root().iterdir())) == 1


@pytest.mark.parametrize("fault", ["mkdir", "chmod", "replace"])
def test_permission_failures_are_clean_and_retryable(artifact, monkeypatch, capsys, fault):
    def denied(*args, **kwargs):
        raise PermissionError("fixture permission denied")

    with monkeypatch.context() as patch:
        if fault == "replace":
            patch.setattr(cli.os, "replace", denied)
        else:
            patch.setattr(Path, fault, denied)
        assert cli.main([]) == 1
    assert "fixture permission denied" in capsys.readouterr().err
    assert not (cli.cache_root() / f"{VERSION}-{TAG}").exists()
    cli.validate_release(cli.application_dir(VERSION, install=True), VERSION)


@pytest.mark.parametrize("name", ["runtime/node/bin/node", "launcher/cli.mjs", "release.json"])
def test_cached_required_file_cannot_escape(artifact, tmp_path, name):
    root = cli.application_dir(VERSION, install=True)
    victim = root / name
    outside = tmp_path / "outside"
    victim.replace(outside)
    victim.symlink_to(outside)
    with pytest.raises(cli.LauncherError, match="unsafe release"):
        cli.application_dir(VERSION, install=False)


def test_cached_release_symlink_rejected(artifact, tmp_path):
    root = cli.application_dir(VERSION, install=True)
    actual = tmp_path / "actual"
    root.rename(actual)
    root.symlink_to(actual, target_is_directory=True)
    with pytest.raises(cli.LauncherError, match="non-symlink"):
        cli.application_dir(VERSION, install=True)


def test_lock_symlink_rejected_without_touching_target(tmp_path):
    cli.cache_root().mkdir(parents=True)
    victim = tmp_path / "victim"
    victim.write_text("unchanged")
    (cli.cache_root() / f".{VERSION}-{TAG}.lock").symlink_to(victim)
    assert cli.main([]) == 1
    assert victim.read_text() == "unchanged"


@pytest.mark.parametrize("version", ["../0.1.0", "0.1.0/../../x", "0.1.0\n", "v0.1.0", "0.1"])
def test_unsafe_metadata_version_rejected(monkeypatch, version):
    monkeypatch.setattr(cli.importlib.metadata, "version", lambda _: version)
    with pytest.raises(cli.LauncherError, match="Invalid package version"):
        cli.package_version()
    assert not cli.cache_root().exists()


@pytest.mark.parametrize("version", ["1.2.3rc1", "1.2.3.dev2", "1.2.3.post1", "1.2.3+local"])
def test_safe_metadata_versions_preserved(monkeypatch, version):
    monkeypatch.setattr(cli.importlib.metadata, "version", lambda _: version)
    assert cli.package_version() == version


@pytest.mark.parametrize("system,machine", [("Linux", "riscv64"), ("FreeBSD", "amd64"), ("Darwin", "i386")])
def test_unsupported_architecture_combinations(monkeypatch, system, machine):
    monkeypatch.setattr(cli.platform, "system", lambda: system)
    monkeypatch.setattr(cli.platform, "machine", lambda: machine)
    with pytest.raises(cli.LauncherError, match="Unsupported platform"):
        REAL_PLATFORM_TAG()


# Separate interpreters exercise flock, atomic publication and SIGKILL recovery.
# Each child is offline by construction; the downloader only copies our fixture.
PROCESS_INSTALL = r"""
import contextlib, hashlib, os, pathlib, shutil, sys
from dsh_rlm import cli
archive, mode = pathlib.Path(sys.argv[1]), sys.argv[2]
cli.platform_tag = lambda: "linux-x64"
def no_network(*args, **kwargs):
    raise AssertionError("network forbidden")
cli.urllib.request.build_opener = no_network
def download(url, destination, limit):
    with (archive.parent / "downloads").open("a") as log:
        log.write(url + "\n")
    if mode == "hold" and url.endswith("SHA256SUMS"):
        print("READY", flush=True)
        assert sys.stdin.readline() == "go\n"
    if url.endswith("SHA256SUMS"):
        destination.write_text(hashlib.sha256(archive.read_bytes()).hexdigest() + "  " + archive.name + "\n")
    else:
        shutil.copyfile(archive, destination)
cli._download = download
original_lock = cli._install_lock
@contextlib.contextmanager
def lock(path):
    if mode == "waiter":
        print("WAITING", flush=True)
    with original_lock(path):
        yield
cli._install_lock = lock
if mode == "kill":
    original_extract = cli._extract
    def extract(*args):
        original_extract(*args)
        print("READY", flush=True)
        sys.stdin.readline()
    cli._extract = extract
root = cli.application_dir("0.1.0", install=True)
cli.validate_release(root, "0.1.0")
print("DONE " + str(root), flush=True)
"""


def start_installer(archive, mode):
    import subprocess

    env = dict(os.environ)
    env["PYTHONPATH"] = str(Path(cli.__file__).parents[1])
    return subprocess.Popen([sys.executable, "-c", PROCESS_INSTALL, str(archive), mode],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, env=env)


def child_line(child):
    import select

    assert select.select([child.stdout], [], [], 10)[0], "child handshake timed out"
    return child.stdout.readline().strip()


def stop_children(children):
    for child in children:
        if child.poll() is None:
            child.kill()
        child.communicate(timeout=10)


def test_real_process_concurrent_install(artifact):
    archive, _ = artifact
    children = []
    try:
        first = start_installer(archive, "hold")
        children.append(first)
        assert child_line(first) == "READY"
        for _ in range(3):
            child = start_installer(archive, "waiter")
            children.append(child)
            assert child_line(child) == "WAITING"
        assert not (cli.cache_root() / f"{VERSION}-{TAG}").exists()
        first.stdin.write("go\n")
        first.stdin.flush()
        for child in children:
            stdout, stderr = child.communicate(timeout=15)
            assert child.returncode == 0, stderr
            assert stdout.startswith("DONE ")
        assert len((archive.parent / "downloads").read_text().splitlines()) == 2
        cli.validate_release(cli.application_dir(VERSION, install=False), VERSION)
        assert len(list(cli.cache_root().iterdir())) == 2  # root and stable lock
    finally:
        stop_children(children)


def test_real_process_kill_before_publish_then_recover(artifact):
    archive, _ = artifact
    children = []
    try:
        killed = start_installer(archive, "kill")
        children.append(killed)
        assert child_line(killed) == "READY"
        assert not (cli.cache_root() / f"{VERSION}-{TAG}").exists()
        abandoned = [p for p in cli.cache_root().iterdir() if p.is_dir()]
        assert len(abandoned) == 1
        assert (abandoned[0] / "bundle/release.json").is_file()
        killed.kill()
        killed.communicate(timeout=10)
        assert killed.returncode < 0
        retry = start_installer(archive, "normal")
        children.append(retry)
        stdout, stderr = retry.communicate(timeout=15)
        assert retry.returncode == 0, stderr
        assert stdout.startswith("DONE ")
        cli.validate_release(cli.application_dir(VERSION, install=False), VERSION)
        assert len((archive.parent / "downloads").read_text().splitlines()) == 4
        # SIGKILL cannot run TemporaryDirectory cleanup. Orphans are ignored,
        # never trusted as an installed release, and do not retain the lock.
        assert abandoned[0].exists()
    finally:
        stop_children(children)


def test_release_appearing_while_waiting_must_not_be_symlink(artifact, monkeypatch, tmp_path):
    import contextlib

    archive, _ = artifact
    actual = tmp_path / "actual"
    actual.mkdir()
    cli._extract(archive, actual)
    root = cli.cache_root() / f"{VERSION}-{TAG}"

    @contextlib.contextmanager
    def raced_lock(path):
        root.symlink_to(actual, target_is_directory=True)
        yield

    monkeypatch.setattr(cli, "_install_lock", raced_lock)
    with pytest.raises(cli.LauncherError, match="non-symlink"):
        cli.application_dir(VERSION, install=True)


def test_real_lock_timeout_does_not_remove_lock(tmp_path, monkeypatch):
    path = tmp_path / "lock"
    with cli._install_lock(path):
        monkeypatch.setattr(cli, "LOCK_TIMEOUT", 0)
        with pytest.raises(cli.LauncherError, match="Timed out waiting"):
            with cli._install_lock(path):
                pytest.fail("Acquired an already held lock")
    with cli._install_lock(path):
        assert path.is_file()


@pytest.mark.parametrize("manifest", ["null", "[]", "{}", "not json", '{"version":"9.9.9"}'])
def test_invalid_cached_manifest_fails_closed(artifact, manifest):
    root = cli.application_dir(VERSION, install=True)
    (root / "release.json").write_text(manifest)
    assert cli.main(["doctor"]) == 1


def test_nonexecutable_cached_node_fails_closed(artifact):
    root = cli.application_dir(VERSION, install=True)
    (root / "runtime/node/bin/node").chmod(0o600)
    with pytest.raises(cli.LauncherError, match="not executable"):
        cli.application_dir(VERSION, install=False)


def test_relative_cache_home_rejected(monkeypatch):
    monkeypatch.setenv("XDG_CACHE_HOME", "relative")
    with pytest.raises(cli.LauncherError, match="absolute path"):
        cli.application_dir(VERSION, install=True)
