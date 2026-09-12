"""Ensure monthly renewal can share its lock without allowing concurrent builders."""
import fcntl
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/build-guest.py'
spec = importlib.util.spec_from_file_location('builder', SCRIPT)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)

class SigningLockTests(unittest.TestCase):
    def test_inherited_lock_works_and_excludes_other_builders(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'signing.lock'
            with path.open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                code = "import importlib.util,pathlib,sys; s=importlib.util.spec_from_file_location('b',sys.argv[1]); b=importlib.util.module_from_spec(s); s.loader.exec_module(b)\nwith b.signing_lock(pathlib.Path(sys.argv[2])): pass"
                inherited = subprocess.run([sys.executable, '-c', code, str(SCRIPT), str(path)],
                    env={**os.environ, 'IOS_REFRESH_LOCK_FD': str(lock.fileno())},
                    pass_fds=(lock.fileno(),), capture_output=True, text=True)
                self.assertEqual(inherited.returncode, 0, inherited.stderr)
                other = subprocess.run([sys.executable, '-c', code, str(SCRIPT), str(path)],
                    env={key: value for key, value in os.environ.items() if key != 'IOS_REFRESH_LOCK_FD'},
                    capture_output=True, text=True)
                self.assertNotEqual(other.returncode, 0)
                self.assertIn('Another app is building', other.stderr)

    def test_wrong_inherited_file_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'signing.lock'
            path.touch()
            with (Path(directory) / 'unrelated').open('a') as unrelated, \
                 patch.dict(os.environ, {'IOS_REFRESH_LOCK_FD': str(unrelated.fileno())}):
                with self.assertRaisesRegex(SystemExit, 'does not match'):
                    with builder.signing_lock(path): pass

if __name__ == '__main__': unittest.main(buffer=True)
