"""Portable regression tests using synthetic Mach-O metadata, never executables."""

import importlib.util
import json
from pathlib import Path
import plistlib
import struct
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "audit-macos-app.py"
SPEC = importlib.util.spec_from_file_location("audit_macos_app", SCRIPT)
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)


def thin(cpu, minimum=0x0B0000, *, endian="<", legacy=False, has_version=True):
    if not has_version:
        command = b""
    elif legacy:
        command = struct.pack(endian + "4I", 0x24, 16, minimum, 0x0F0000)
    else:
        command = struct.pack(endian + "6I", 0x32, 24, 1, minimum, 0x0F0000, 0)
    return struct.pack(endian + "8I", 0xFEEDFACF, cpu, 0, 2, bool(command), len(command), 0, 0) + command


def universal(slices, *, endian=">", fat64=False):
    stride = 32 if fat64 else 20
    offset = 8 + len(slices) * stride
    data = struct.pack(endian + "II", 0xCAFEBABF if fat64 else 0xCAFEBABE, len(slices))
    for cpu, blob in slices:
        values = (cpu, 0, offset, len(blob), 0)
        if fat64:
            values += (0,)
        data += struct.pack(endian + ("IIQQII" if fat64 else "IIIII"), *values)
        offset += len(blob)
    return data + b"".join(blob for _, blob in slices)


class MacBundleAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="shiftflow-audit-test-")
        self.addCleanup(self.temp.cleanup)
        self.app = Path(self.temp.name) / "Shift Schedule Expert.app"
        self.binary = self.app / "Contents" / "MacOS" / "main"
        self.binary.parent.mkdir(parents=True)
        self.write_info()

    def write_info(self, minimum="11.0", per_arch=None):
        info = {"CFBundleExecutable": "main", "LSMinimumSystemVersion": minimum}
        if per_arch is not None:
            info["LSMinimumSystemVersionByArchitecture"] = per_arch
        (self.app / "Contents" / "Info.plist").write_bytes(plistlib.dumps(info))

    def dependency(self, data, name="numpy/core/native.so"):
        path = self.app / "Contents" / "Resources" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def test_default_arm64_preserves_legacy_fields_and_reports_mismatch_only(self):
        self.binary.write_bytes(thin(AUDIT.ARM64))
        self.dependency(thin(AUDIT.ARM64, 0x0E0000))
        report = AUDIT.audit_app(str(self.app))
        self.assertTrue(report["validation"]["passed"])
        self.assertEqual(report["target_architecture"], "arm64")
        summary = report["summary"]
        self.assertEqual(summary["macos_arm64_max_minos"], "14.0.0")
        self.assertEqual(summary["macos_target_max_minos"], summary["macos_arm64_max_minos"])
        self.assertEqual(summary["arm64_object_count"], summary["target_object_count"])
        self.assertTrue(summary["all_macho_objects_contain_arm64"])
        assessment = report["minimum_system_assessment"]
        self.assertEqual(assessment["effective_declared_arm64_minimum"], "11.0")
        self.assertEqual(assessment["observed_macos_arm64_max_minos"], "14.0.0")
        self.assertTrue(assessment["declaration_understates_observed_minimum"])
        component = report["key_components"]["numpy"][0]
        self.assertEqual(component["arm64_version_commands"], component["target_version_commands"])

    def test_intel_only_app_passes_without_any_arm64_slice(self):
        self.binary.write_bytes(thin(AUDIT.X86_64, 0x0C0000, legacy=True))
        self.dependency(thin(AUDIT.X86_64, 0x0D0000))
        report = AUDIT.audit_app(str(self.app), "x86_64")
        self.assertTrue(report["validation"]["passed"])
        self.assertTrue(report["summary"]["all_macho_objects_contain_target_architecture"])
        self.assertEqual(report["summary"]["macos_target_max_minos"], "13.0.0")
        self.assertEqual(report["summary"]["x86_64_object_count"], 2)
        self.assertNotIn("arm64_object_count", report["summary"])
        self.assertNotIn("arm64_version_commands", report["key_components"]["main"][0])
        self.assertFalse(AUDIT.audit_app(str(self.app))["validation"]["passed"])

    def test_universal_minimum_and_plist_override_are_selected_by_architecture(self):
        self.binary.write_bytes(universal([
            (AUDIT.ARM64, thin(AUDIT.ARM64, 0x0E0000)),
            (AUDIT.X86_64, thin(AUDIT.X86_64, 0x0C0300, legacy=True)),
        ]))
        self.write_info("10.15", {"arm64": "14.0", "x86_64": "12.3"})
        for arch, expected, declared in [("arm64", "14.0.0", "14.0"), ("x86_64", "12.3.0", "12.3")]:
            with self.subTest(arch=arch):
                report = AUDIT.audit_app(str(self.app), arch)
                self.assertTrue(report["validation"]["passed"])
                self.assertEqual(report["summary"]["macos_target_max_minos"], expected)
                self.assertEqual(report["minimum_system_assessment"]["effective_declared_minimum"], declared)
                self.assertFalse(report["minimum_system_assessment"]["declaration_understates_observed_minimum"])

    def test_every_dependency_must_include_selected_architecture(self):
        self.binary.write_bytes(universal([
            (AUDIT.ARM64, thin(AUDIT.ARM64)), (AUDIT.X86_64, thin(AUDIT.X86_64)),
        ]))
        for target, other in [("arm64", AUDIT.X86_64), ("x86_64", AUDIT.ARM64)]:
            with self.subTest(arch=target):
                self.dependency(thin(other))
                report = AUDIT.audit_app(str(self.app), target)
                self.assertFalse(report["validation"]["passed"])
                self.assertTrue(any(error["code"] == f"macho_missing_{target}" for error in report["validation"]["errors"]))

    def test_fat_variants_and_thin_endianness_remain_supported(self):
        for endian in ("<", ">"):
            for fat64 in (False, True):
                with self.subTest(endian=endian, fat64=fat64):
                    self.binary.write_bytes(universal([
                        (AUDIT.ARM64, thin(AUDIT.ARM64, 0x0E0000, endian=endian)),
                        (AUDIT.X86_64, thin(AUDIT.X86_64, 0x0B0000, endian=endian, legacy=True)),
                    ], endian=endian, fat64=fat64))
                    report = AUDIT.audit_app(str(self.app), "x86_64")
                    self.assertTrue(report["validation"]["passed"])
                    self.assertEqual(report["summary"]["macos_target_max_minos"], "11.0.0")

    def test_missing_version_metadata_does_not_borrow_other_slice_minimum(self):
        self.binary.write_bytes(universal([
            (AUDIT.ARM64, thin(AUDIT.ARM64, 0x0E0000)),
            (AUDIT.X86_64, thin(AUDIT.X86_64, has_version=False)),
        ]))
        report = AUDIT.audit_app(str(self.app), "x86_64")
        self.assertIsNone(report["summary"]["macos_target_max_minos"])
        self.assertEqual(report["summary"]["target_objects_without_macos_minimum"], ["Contents/MacOS/main"])
        self.assertTrue(any(warning["code"] == "x86_64_minimum_not_declared" for warning in report["validation"]["warnings"]))

    def test_symlink_checks_apply_to_intel_target(self):
        self.binary.write_bytes(thin(AUDIT.X86_64))
        link = self.binary.parent / "alias"
        try:
            link.symlink_to("main")
        except OSError:
            self.skipTest("Creating symlinks is unavailable on this test host")
        self.assertTrue(AUDIT.audit_app(str(self.app), "x86_64")["validation"]["passed"])
        link.unlink()
        link.symlink_to(self.temp.name)
        self.assertFalse(AUDIT.audit_app(str(self.app), "x86_64")["validation"]["passed"])
        link.unlink()
        link.symlink_to("missing")
        self.assertFalse(AUDIT.audit_app(str(self.app), "x86_64")["validation"]["passed"])

    def test_cli_target_selection_and_exit_status(self):
        self.binary.write_bytes(thin(AUDIT.X86_64, 0x0E0000))
        completed = subprocess.run([sys.executable, str(SCRIPT), str(self.app), "--arch", "x86_64"], capture_output=True, text=True)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(json.loads(completed.stdout)["target_architecture"], "x86_64")
        completed = subprocess.run([sys.executable, str(SCRIPT), str(self.app)], capture_output=True, text=True)
        self.assertEqual(completed.returncode, 1, completed.stderr)
        self.assertFalse(json.loads(completed.stdout)["validation"]["passed"])


if __name__ == "__main__":
    unittest.main()
