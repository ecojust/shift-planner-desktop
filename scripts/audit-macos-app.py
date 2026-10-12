#!/usr/bin/env python3
"""Inspect a macOS .app without running any executable inside the bundle.

Usage: python3 scripts/audit-macos-app.py /path/to/ShiftFlow.app [--arch arm64|x86_64] > audit.json
Exit 1 means a structural, architecture, or symlink validation failed. A bundle
declaring an older macOS version than a dependency's minos is reported, but does
not fail this audit. This report is static evidence, not an installation test.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import plistlib
import struct
import sys
from typing import BinaryIO


ARM64 = 0x0100000C
X86_64 = 0x01000007
TARGET_CPUS = {"arm64": ARM64, "x86_64": X86_64}
MACOS = 1
THIN_MAGIC = {
    b"\xce\xfa\xed\xfe": ("<", 28),
    b"\xcf\xfa\xed\xfe": ("<", 32),
    b"\xfe\xed\xfa\xce": (">", 28),
    b"\xfe\xed\xfa\xcf": (">", 32),
}
FAT_MAGIC = {
    b"\xca\xfe\xba\xbe": (">", False),
    b"\xbe\xba\xfe\xca": ("<", False),
    b"\xca\xfe\xba\xbf": (">", True),
    b"\xbf\xba\xfe\xca": ("<", True),
}
CPU_NAMES = {ARM64: "arm64", X86_64: "x86_64", 7: "i386", 12: "arm"}
PLATFORM_NAMES = {1: "macOS", 2: "iOS", 3: "tvOS", 4: "watchOS", 6: "Mac Catalyst"}


def version(number: int) -> str:
    return f"{number >> 16}.{(number >> 8) & 255}.{number & 255}"


def version_key(value: str) -> tuple[int, ...]:
    parts = tuple(int(part) for part in value.split("."))
    return parts + (0,) * max(0, 3 - len(parts))


def read_at(stream: BinaryIO, position: int, count: int) -> bytes:
    stream.seek(position)
    data = stream.read(count)
    if len(data) != count:
        raise ValueError("Truncated Mach-O data")
    return data


def inspect_macho(path: Path) -> dict | None:
    """Read only headers and load commands, including every universal slice."""
    length = path.stat().st_size
    if length < 4:
        return None
    with path.open("rb") as stream:
        magic = read_at(stream, 0, 4)
        if magic not in THIN_MAGIC and magic not in FAT_MAGIC:
            return None
        slices = []

        def inspect_slice(base: int, size: int, expected_cpu: int | None = None):
            if size < 4 or base < 0 or base + size > length:
                raise ValueError("Mach-O slice lies outside the file")
            slice_magic = read_at(stream, base, 4)
            if slice_magic not in THIN_MAGIC:
                raise ValueError("Universal binary contains a non-Mach-O slice")
            endian, header_size = THIN_MAGIC[slice_magic]
            if size < header_size:
                raise ValueError("Truncated Mach-O header")
            header = read_at(stream, base, header_size)
            cpu, subtype = struct.unpack_from(endian + "II", header, 4)
            if expected_cpu is not None and cpu != expected_cpu:
                raise ValueError("Universal architecture table and slice disagree")
            ncmds, command_bytes = struct.unpack_from(endian + "II", header, 16)
            if header_size + command_bytes > size or ncmds > command_bytes // 8:
                raise ValueError("Invalid Mach-O load command extent")
            position = base + header_size
            command_end = position + command_bytes
            versions = []
            for _ in range(ncmds):
                if position + 8 > command_end:
                    raise ValueError("Truncated Mach-O load command")
                command, command_size = struct.unpack(endian + "II", read_at(stream, position, 8))
                if command_size < 8 or position + command_size > command_end:
                    raise ValueError("Invalid Mach-O load command size")
                if command == 0x32:  # LC_BUILD_VERSION
                    if command_size < 24:
                        raise ValueError("Truncated LC_BUILD_VERSION")
                    platform, minimum, sdk, _ = struct.unpack(endian + "IIII", read_at(stream, position + 8, 16))
                    versions.append({
                        "command": "LC_BUILD_VERSION", "platform": platform,
                        "platform_name": PLATFORM_NAMES.get(platform, f"platform-{platform}"),
                        "minos": version(minimum), "sdk": version(sdk),
                    })
                elif command == 0x24:  # LC_VERSION_MIN_MACOSX
                    if command_size < 16:
                        raise ValueError("Truncated LC_VERSION_MIN_MACOSX")
                    minimum, sdk = struct.unpack(endian + "II", read_at(stream, position + 8, 8))
                    versions.append({
                        "command": "LC_VERSION_MIN_MACOSX", "platform": MACOS,
                        "platform_name": "macOS", "minos": version(minimum), "sdk": version(sdk),
                    })
                position += command_size
            slices.append({
                "architecture": CPU_NAMES.get(cpu, f"cpu-0x{cpu:08x}"),
                "cpu_type": cpu, "cpu_subtype": subtype,
                "offset": base, "bytes": size, "version_commands": versions,
            })

        if magic in FAT_MAGIC:
            endian, fat64 = FAT_MAGIC[magic]
            count = struct.unpack(endian + "I", read_at(stream, 4, 4))[0]
            stride = 32 if fat64 else 20
            if count == 0 or 8 + count * stride > length:
                raise ValueError("Invalid universal architecture table")
            for index in range(count):
                arch = read_at(stream, 8 + index * stride, stride)
                cpu = struct.unpack_from(endian + "I", arch)[0]
                offset, size = struct.unpack_from(endian + ("QQ" if fat64 else "II"), arch, 8)
                inspect_slice(offset, size, cpu)
        else:
            inspect_slice(0, length)
    return {"bytes": length, "slices": slices}


def audit_app(argument: str, arch: str = "arm64") -> dict:
    if arch not in TARGET_CPUS:
        raise ValueError(f"Unsupported target architecture: {arch}")
    target_cpu = TARGET_CPUS[arch]
    errors: list[dict] = []
    warnings: list[dict] = []
    root = Path(argument).expanduser().resolve()
    report = {
        "schema_version": 1,
        "app_path": str(root),
        "target_architecture": arch,
        "method": "Static Mach-O load-command and bundle-path inspection; no bundled program was executed.",
        "bundle": {}, "summary": {}, "minimum_system_assessment": {},
        "key_components": {"main": [], "solver": [], "python": [], "numpy": [], "ortools": []},
        "macho_objects": [], "symlinks": [],
        "validation": {"passed": False, "errors": errors, "warnings": warnings},
    }
    if not root.is_dir():
        errors.append({"code": "app_directory_missing", "path": str(root)})
        return report

    def relative(path: Path) -> str:
        return path.relative_to(root).as_posix()

    def safe_path(path: Path) -> Path:
        resolved = path.resolve(strict=True)
        if not resolved.is_relative_to(root):
            raise ValueError("Resolved path escapes the .app bundle")
        return resolved

    def walk_error(error: OSError):
        errors.append({"code": "directory_unreadable", "path": str(error.filename), "message": str(error)})

    for directory, directories, files in os.walk(root, followlinks=False, onerror=walk_error):
        for name in sorted(directories + files):
            path = Path(directory) / name
            if not path.is_symlink():
                continue
            item = {"path": relative(path), "target": os.readlink(path), "valid": False}
            try:
                item["resolved_path"] = relative(safe_path(path))
                item["valid"] = True
            except (OSError, RuntimeError, ValueError) as error:
                item["error"] = str(error)
                errors.append({"code": "invalid_symlink", "path": relative(path), "message": str(error)})
            report["symlinks"].append(item)
        for name in sorted(files):
            path = Path(directory) / name
            if path.is_symlink() or not path.is_file():
                continue  # Valid aliases are inspected through their real target once.
            try:
                item = inspect_macho(path)
                if item is None:
                    continue
                item["path"] = relative(path)
                report["macho_objects"].append(item)
                target_slices = [slice_ for slice_ in item["slices"] if slice_["cpu_type"] == target_cpu]
                if not target_slices:
                    errors.append({"code": f"macho_missing_{arch}", "path": relative(path), "target_architecture": arch})
                for slice_ in target_slices:
                    if not slice_["version_commands"]:
                        warnings.append({"code": f"{arch}_minimum_not_declared", "path": relative(path)})
                    elif any(command["platform"] != MACOS for command in slice_["version_commands"]):
                        warnings.append({"code": f"{arch}_non_macos_platform", "path": relative(path)})
            except (OSError, ValueError, struct.error) as error:
                errors.append({"code": "file_inspection_failed", "path": relative(path), "message": str(error)})

    report["macho_objects"].sort(key=lambda item: item["path"])
    report["symlinks"].sort(key=lambda item: item["path"])
    info = {}
    try:
        with safe_path(root / "Contents" / "Info.plist").open("rb") as stream:
            info = plistlib.load(stream)
        if not isinstance(info, dict):
            raise ValueError("Info.plist must contain a dictionary")
        report["bundle"] = {key: info.get(key) for key in (
            "CFBundleIdentifier", "CFBundleName", "CFBundleExecutable", "CFBundleShortVersionString",
            "CFBundleVersion", "LSMinimumSystemVersion", "LSMinimumSystemVersionByArchitecture",
        )}
    except (OSError, RuntimeError, ValueError, plistlib.InvalidFileException) as error:
        errors.append({"code": "info_plist_invalid", "message": str(error)})

    main_path = None
    executable = info.get("CFBundleExecutable")
    if isinstance(executable, str) and executable:
        try:
            main_path = relative(safe_path(root / "Contents" / "MacOS" / executable))
        except (OSError, RuntimeError, ValueError) as error:
            errors.append({"code": "main_executable_invalid", "message": str(error)})
    else:
        errors.append({"code": "main_executable_not_declared"})

    all_versions = []
    macos_versions = []
    target_objects = 0
    minimum_unknown = []
    for item in report["macho_objects"]:
        target_slices = [slice_ for slice_ in item["slices"] if slice_["cpu_type"] == target_cpu]
        if target_slices:
            target_objects += 1
        commands = [command for slice_ in target_slices for command in slice_["version_commands"]]
        all_versions.extend(command["minos"] for command in commands)
        macos_versions.extend(command["minos"] for command in commands if command["platform"] == MACOS)
        if target_slices and not any(command["platform"] == MACOS for command in commands):
            minimum_unknown.append(item["path"])
        path_lower = "/" + item["path"].lower()
        basename = Path(item["path"]).name.lower()
        categories = []
        if item["path"] == main_path:
            categories.append("main")
        if "shiftflow-solver" in basename:
            categories.append("solver")
        if basename == "python" or basename.startswith("libpython"):
            categories.append("python")
        if "/numpy/" in path_lower or "/numpy.libs/" in path_lower:
            categories.append("numpy")
        if "/ortools/" in path_lower or "/ortools.libs/" in path_lower or "libortools" in basename:
            categories.append("ortools")
        compact = {"path": item["path"], "architectures": [slice_["architecture"] for slice_ in item["slices"]],
                   "target_architecture": arch, "target_version_commands": commands,
                   f"{arch}_version_commands": commands}
        for category in categories:
            report["key_components"][category].append(compact)
    if not report["macho_objects"]:
        errors.append({"code": "no_macho_objects"})
    if main_path is not None and not report["key_components"]["main"]:
        errors.append({"code": "main_executable_not_macho", "path": main_path})

    maximum = max(all_versions, key=version_key) if all_versions else None
    macos_maximum = max(macos_versions, key=version_key) if macos_versions else None
    declared = info.get("LSMinimumSystemVersion")
    per_architecture = info.get("LSMinimumSystemVersionByArchitecture")
    if isinstance(per_architecture, dict) and per_architecture.get(arch):
        declared = per_architecture[arch]
    understated = None
    if isinstance(declared, str) and macos_maximum:
        try:
            understated = version_key(declared) < version_key(macos_maximum)
        except ValueError:
            warnings.append({"code": "invalid_declared_minimum", "value": declared})
    if understated:
        warnings.append({"code": "declared_minimum_below_bundled_dependency",
                         "declared": declared, "target_architecture": arch,
                         "observed_macos_max_minos": macos_maximum,
                         f"observed_macos_{arch}_max_minos": macos_maximum})
    report["summary"] = {
        "macho_object_count": len(report["macho_objects"]),
        "target_architecture": arch, "target_object_count": target_objects,
        "all_macho_objects_contain_target_architecture": bool(target_objects) and target_objects == len(report["macho_objects"]),
        "target_max_minos": maximum, "macos_target_max_minos": macos_maximum,
        "target_objects_without_macos_minimum": minimum_unknown,
        # Architecture-specific aliases preserve the existing ARM64 report schema.
        f"{arch}_object_count": target_objects,
        f"all_macho_objects_contain_{arch}": bool(target_objects) and target_objects == len(report["macho_objects"]),
        f"{arch}_max_minos": maximum, f"macos_{arch}_max_minos": macos_maximum,
        f"{arch}_objects_without_macos_minimum": minimum_unknown,
        "symlink_count": len(report["symlinks"]),
        "all_symlinks_internal_and_resolvable": all(link["valid"] for link in report["symlinks"]),
    }
    report["minimum_system_assessment"] = {
        "target_architecture": arch,
        "effective_declared_minimum": declared,
        "observed_macos_max_minos": macos_maximum,
        f"effective_declared_{arch}_minimum": declared,
        f"observed_macos_{arch}_max_minos": macos_maximum,
        "declaration_understates_observed_minimum": understated,
        "observed_maximum_objects": [item["path"] for item in report["macho_objects"] if any(
            command["platform"] == MACOS and command["minos"] == macos_maximum
            for slice_ in item["slices"] if slice_["cpu_type"] == target_cpu for command in slice_["version_commands"]
        )],
        "limitation": f"This is the highest declared minimum among bundled macOS {arch} objects, not a runtime compatibility guarantee. Optional libraries may not always load; undeclared requirements and actual OS behavior still require testing. SDK versions are not minimum OS versions.",
    }
    report["validation"]["passed"] = not errors
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", help="Path to the extracted .app directory")
    parser.add_argument("--arch", choices=tuple(TARGET_CPUS), default="arm64", help="Required Mach-O architecture (default: arm64)")
    arguments = parser.parse_args()
    report = audit_app(arguments.app, arguments.arch)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["validation"]["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
