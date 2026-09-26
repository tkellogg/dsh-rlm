#!/usr/bin/env python3
"""Offline checks of the optional uv-only convenience wrapper."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]

class BootstrapTests(unittest.TestCase):
    def test_requires_uv_without_downloading_anything(self):
        with tempfile.TemporaryDirectory() as d:
            result = subprocess.run(["/bin/sh", str(ROOT / "install.sh")],
                                    env={**os.environ, "PATH": d}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn("Install uv first", result.stderr)

    def test_delegates_install_and_arguments_to_uv(self):
        with tempfile.TemporaryDirectory(prefix="uv test ") as d:
            uv = Path(d) / "uv"
            uv.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n')
            uv.chmod(0o755)
            result = subprocess.run(["/bin/sh", str(ROOT / "install.sh"), "--python", "3.13"],
                                    env={**os.environ, "PATH": d}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout.splitlines(), ["tool", "install", "dsh-rlm", "--python", "3.13"])

if __name__ == "__main__":
    unittest.main()
