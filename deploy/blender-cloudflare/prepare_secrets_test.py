import contextlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("prepare_secrets", Path(__file__).with_name("prepare-secrets.py"))
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class PrepareSecretsTests(unittest.TestCase):
    def test_private_atomic_save_and_symlink_rejection(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "private" / "secrets.json"
            prepare.save_private(path, {"test": "fixture"})
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
            target = path.with_name("target.json")
            target.write_text("untouched")
            link = path.with_name("link.json")
            link.symlink_to(target)
            with self.assertRaises(ValueError):
                prepare.save_private(link, {"test": "replacement"})
            self.assertEqual(target.read_text(), "untouched")

    def test_insecure_existing_file_is_rejected_without_modification(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "secrets.json"
            path.write_text("untouched")
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                prepare.save_private(path, {"test": "replacement"})
            self.assertEqual(path.read_text(), "untouched")

    def test_input_mismatch_does_not_create_secret_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "secrets.json"
            capture = io.StringIO()
            capture.isatty = lambda: True
            with patch.object(prepare, "SECRET_FILE", path), \
                    patch.object(prepare.sys.stdin, "isatty", return_value=True), \
                    patch.object(prepare.getpass, "getpass", side_effect=["a" * 20, "s" * 20, "x" * 20]), \
                    contextlib.redirect_stdout(capture):
                with self.assertRaises(ValueError):
                    prepare.main()
            self.assertFalse(path.exists())

    def test_rerun_preserves_encryption_secret_and_never_prints_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "secrets.json"
            service = "old-service-secret-" + "z" * 40
            model = "fixture-model-secret-" + "m" * 20
            prepare.save_private(path, {"BLENDER_SERVICE_SECRET": service, "VOLC_KEY": model})
            capture = io.StringIO()
            capture.isatty = lambda: True
            with patch.object(prepare, "SECRET_FILE", path), \
                    patch.object(prepare.sys.stdin, "isatty", return_value=True), \
                    patch.object(prepare.getpass, "getpass", side_effect=["a" * 20, "s" * 20, "s" * 20]), \
                    contextlib.redirect_stdout(capture):
                prepare.main()
            values = json.loads(path.read_text())
            self.assertEqual(values["BLENDER_SERVICE_SECRET"], service)
            self.assertEqual(values["VOLC_KEY"], model)
            self.assertEqual(values["TOS_SECRET_KEY"], values["VOLC_SECRETKEY"])
            for secret in values.values():
                self.assertNotIn(secret, capture.getvalue())


if __name__ == "__main__":
    unittest.main()
