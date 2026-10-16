"""
Excel Formula Recalculation Script
Recalculates all formulas in an Excel file using pycel (primary) or LibreOffice (fallback)
"""

import contextlib
import io
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

from openpyxl import load_workbook

MACRO_FILENAME = "Module1.xba"
# LibreOffice 不再被加入系统 PATH（见 settings.js downloadLibreOffice），
# soffice 一律按绝对路径探测（office.soffice.find_soffice）。
SOFFICE_MISSING = "LibreOffice (soffice) not found; install it via the settings page (optional, ~300MB), or use --check/--bake without it"

MAX_LOCATIONS = 100

EXTERNAL_REF_RE = re.compile(r"""(?<![\w"\[])'?\[\d+\][^!"\[\]]*'?!""")

# Excel 错误值集合（缓存值恰好等于其中之一才算公式错误）。
EXCEL_ERRORS = ["#VALUE!", "#DIV/0!", "#REF!", "#NAME?", "#NULL!", "#NUM!", "#N/A"]

RECALCULATE_MACRO = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE script:module PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "module.dtd">
<script:module xmlns:script="http://openoffice.org/2000/script" script:name="Module1" script:language="StarBasic">
    Sub RecalculateAndSave()
      ThisComponent.calculateAll()
      ThisComponent.store()
      ThisComponent.close(True)
    End Sub
</script:module>"""


def _stamp(path):
    st = os.stat(path)
    return st.st_mtime_ns, st.st_size


def external_links_at_risk(filename):
    try:
        with zipfile.ZipFile(filename) as archive:
            names = archive.namelist()
    except (zipfile.BadZipFile, OSError):
        return []
    if not any(n.startswith("xl/externalLinks/") for n in names):
        return []

    with contextlib.ExitStack() as stack:
        formulas = load_workbook(filename, data_only=False)
        stack.callback(formulas.close)
        values = load_workbook(filename, data_only=True)
        stack.callback(values.close)

        external_names = [
            name
            for name, dn in formulas.defined_names.items()
            if isinstance(getattr(dn, "value", None), str) and EXTERNAL_REF_RE.search(dn.value)
        ]
        name_re = (
            re.compile(r"\b(" + "|".join(re.escape(n) for n in external_names) + r")\b")
            if external_names
            else None
        )

        at_risk = []
        for sheet in formulas.sheetnames:
            ws = formulas[sheet]
            if not hasattr(ws, "iter_rows"):
                continue
            cached = values[sheet]
            for row in ws.iter_rows():
                for cell in row:
                    v = cell.value
                    if not (isinstance(v, str) and v.startswith("=")):
                        continue
                    reaches_out = EXTERNAL_REF_RE.search(v) or (name_re and name_re.search(v))
                    if reaches_out and cached[cell.coordinate].value is None:
                        at_risk.append(f"{sheet}!{cell.coordinate}")
        return at_risk


def recalc(filename, timeout=30, force=False, mode="check"):
    """Recalculate / validate formulas in an Excel file.

    Three modes (mutually exclusive):
      - mode="check" (default): validate in memory with pycel, DO NOT write to
        disk. The file keeps its formulas untouched — Excel/WPS will recompute
        on open. This is the safe default for delivering formula-bearing files.
      - mode="bake": evaluate with pycel and write the computed values back as
        literals (a static snapshot — formulas are lost on purpose). Only for
        one-off exports that will not be edited again.
      - mode="cache": use LibreOffice to write cached values while KEEPING the
        formulas (the only path that gives you both). Requires LibreOffice.
    """
    if not Path(filename).exists():
        return {"error": f"File {filename} does not exist"}

    abs_path = str(Path(filename).absolute())
    writes_to_disk = mode in ("bake", "cache")

    # Only write modes need write access & external-link protection.
    if writes_to_disk and not os.access(abs_path, os.W_OK):
        return {"error": f"{filename} is not writable; recalculation rewrites the file in place"}

    if writes_to_disk and not force:
        try:
            at_risk = external_links_at_risk(filename)
        except Exception as e:
            return {"error": f"Could not inspect {filename} for external links: {e}"}
        if at_risk:
            shown = at_risk[:MAX_LOCATIONS]
            return {
                "error": (
                    "Refusing to recalculate: this workbook links to another workbook, and "
                    f"{len(at_risk)} linked cell(s) have lost their cached value (openpyxl strips "
                    "these on save). Recalculating would resolve them to #NAME? and delete the "
                    "external links for good. Copy those cells' values from the original file "
                    "before saving, or pass --force to accept the loss. Charts and conditional "
                    "formats can hold external references too, so this list may not be exhaustive."
                ),
                "external_link_cells": shown,
                "external_link_cells_truncated": max(0, len(at_risk) - len(shown)),
            }

    if mode == "check":
        # Validate only — never touches the file. Requires pycel; no LO fallback
        # because LibreOffice always rewrites the file, which a check must not do.
        try:
            return _recalc_with_pycel(filename, abs_path, writeback=False)
        except ImportError:
            return {"error": "pycel is not installed. Install it: pip install pycel"}
        except Exception as e:
            return {"error": f"pycel could not evaluate {filename}: {e}"}

    if mode == "bake":
        # Static snapshot: pycel values replace formulas on purpose.
        try:
            return _recalc_with_pycel(filename, abs_path, writeback=True)
        except ImportError:
            if _libreoffice_available():
                # LibreOffice does the same job AND keeps the formulas — strictly better.
                with tempfile.TemporaryDirectory(
                    prefix="recalc-lo-profile-", ignore_cleanup_errors=True
                ) as profile_dir:
                    result = _recalc_with_libreoffice(filename, abs_path, timeout, Path(profile_dir))
                    if "error" not in result:
                        result["mode"] = "cache"
                        result["note"] = (
                            "pycel is not installed; fell back to LibreOffice, so formulas were "
                            "kept and cached values written (better than a bake)."
                        )
                    return result
            return {"error": "bake requires pycel (pip install pycel), or --cache with LibreOffice installed"}
        except Exception as e:
            # pycel blew up mid-evaluation. If LibreOffice is around, a cache
            # (formulas kept + cached values) is still better than failing.
            if _libreoffice_available():
                with tempfile.TemporaryDirectory(
                    prefix="recalc-lo-profile-", ignore_cleanup_errors=True
                ) as profile_dir:
                    result = _recalc_with_libreoffice(filename, abs_path, timeout, Path(profile_dir))
                    if "error" not in result:
                        result["mode"] = "cache"
                        result["note"] = f"pycel evaluation failed ({e}); fell back to LibreOffice (formulas kept + cached values written)."
                    return result
            return {"error": f"pycel could not evaluate {filename}: {e}"}

    if mode == "cache":
        # Keep formulas + write cached values — LibreOffice only.
        if not _libreoffice_available():
            return {
                "error": (
                    "--cache keeps formulas and writes cached values, which requires LibreOffice. "
                    "It is not installed. Options: install LibreOffice (optional, ~300MB), or use "
                    "--bake for a static value snapshot (formulas are lost), or --check to validate "
                    "without touching the file (formulas stay; Excel/WPS recompute on open)."
                )
            }
        with tempfile.TemporaryDirectory(
            prefix="recalc-lo-profile-", ignore_cleanup_errors=True
        ) as profile_dir:
            return _recalc_with_libreoffice(filename, abs_path, timeout, Path(profile_dir))

    return {"error": f"Unknown mode: {mode!r} (expected check, bake or cache)"}


def _libreoffice_available():
    """Check if LibreOffice (soffice) is available, by absolute path (not PATH)."""
    try:
        sys.path.insert(0, str(Path(__file__).parent))
        from office.soffice import find_soffice, get_soffice_env

        exe = find_soffice()
        if not exe:
            return False
        result = subprocess.run(
            [exe, "--version"],
            capture_output=True,
            timeout=5,
            env=get_soffice_env(),
        )
        return result.returncode == 0
    except Exception:
        return False


def _recalc_with_pycel(filename, abs_path, writeback):
    """Evaluate formulas with pycel.

    writeback=False (mode=check): pure in-memory validation. The file is never
    opened for writing, so formulas are preserved untouched. Errors and
    unresolved formulas are reported from the evaluation results directly.

    writeback=True (mode=bake): evaluate with pycel, then overwrite each
    formula cell with its computed literal value and save. This is an explicit
    "static snapshot": the file keeps NO formulas afterwards, by design.
    """
    import pycel

    # Load with pycel
    compiler = pycel.ExcelCompiler(abs_path)

    # Load workbook to find formula cells
    wb = load_workbook(abs_path, data_only=False)
    formula_cells = []
    formula_count = 0

    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        if not hasattr(ws, "iter_rows"):
            continue
        for row in ws.iter_rows():
            for cell in row:
                if cell.value and isinstance(cell.value, str) and cell.value.startswith("="):
                    formula_cells.append((sheet_name, cell.coordinate))
                    formula_count += 1

    wb.close()

    # Evaluate every formula in memory.
    #
    # NOTE on bulk evaluation (why NOT a "whole-graph one-shot call"):
    # pycel 1.0b30 binds ExcelCompiler.evaluate to _evaluate_non_iterative and
    # does NOT support the no-arg all-formulas form (it raises TypeError);
    # compiler.recalculate() requires cell_map to be pre-populated (i.e. it
    # costs the same as evaluating once); and evaluate(tuple_of_addrs) is
    # measurably the same speed as this per-cell loop (benchmarked on 25,000
    # formulas: 81.4s vs 84.4s). pycel builds its dependency graph lazily and
    # caches each cell's computed value on the shared compiler, so evaluating
    # cells one by one in a single compiler instance computes each dependency
    # only once — overall O(formulas), not O(formulas x graph). The ~3.4 ms
    # per formula is pycel's own interpreter cost; for workbooks that must be
    # written back with cached values, --cache (LibreOffice whole-book
    # recalculation) is an order of magnitude faster and keeps formulas.
    #
    # pycel logs a noisy traceback to stderr for every failing formula
    # (ZeroDivisionError, UnknownFunction, ...), which would flood the tool
    # output on large files — suppress it during bulk evaluation; each failure
    # is still captured below as unresolved.
    results = {}
    unresolved = []  # pycel could not evaluate these → they stay as-is
    with contextlib.redirect_stderr(io.StringIO()):
        for sheet_name, cell in formula_cells:
            try:
                results[(sheet_name, cell)] = compiler.evaluate(cell)
            except Exception:
                unresolved.append(f"{sheet_name}!{cell}")

    if writeback:
        # Bake: write computed values back to file (replacing formulas with values)
        wb = load_workbook(abs_path)

        for (sheet_name, cell), value in results.items():
            ws = wb[sheet_name]
            ws[cell] = value

        wb.save(abs_path)
        wb.close()

    # Build the report from the in-memory results (only formula cells are
    # inspected — no false positives from plain text that happens to contain
    # "#N/A" etc.), then attach mode / write-state metadata.
    report = _summarize_values(results, formula_count)
    report["mode"] = "bake" if writeback else "check"
    report["file_modified"] = bool(writeback)
    if unresolved:
        shown = unresolved[:MAX_LOCATIONS]
        report["unresolved_formulas"] = {
            "count": len(unresolved),
            "locations": shown,
            "locations_truncated": max(0, len(unresolved) - len(shown)),
        }
    return report


def _summarize_values(results, formula_count):
    """Build an error report from in-memory evaluation results.

    Only evaluated formula cells are inspected (results values), so plain text
    that happens to contain "#N/A" etc. is never misreported as a formula error.
    """
    error_details = {err: [] for err in EXCEL_ERRORS}
    total_errors = 0

    for (sheet_name, cell), value in results.items():
        if value is None:
            continue
        stripped = str(value).strip()
        # Exact-match only, same policy as the LibreOffice report below:
        # a cell is an error iff its evaluated value IS the error string.
        for err in EXCEL_ERRORS:
            if stripped == err:
                location = f"{sheet_name}!{cell}"
                error_details[err].append(location)
                total_errors += 1
                break

    result = {
        "status": "success" if total_errors == 0 else "errors_found",
        "total_errors": total_errors,
        "total_formulas": formula_count,
        "error_summary": {},
    }

    for err_type, locations in error_details.items():
        if locations:
            entry = {"count": len(locations), "locations": locations[:MAX_LOCATIONS]}
            if len(locations) > MAX_LOCATIONS:
                entry["locations_truncated"] = len(locations) - MAX_LOCATIONS
            result["error_summary"][err_type] = entry

    return result


def _recalc_with_libreoffice(filename, abs_path, timeout, profile_dir):
    """Recalculate formulas via LibreOffice (mode=--cache).

    This preserves formulas and adds cached values to the xlsx XML.
    """
    try:
        from office.soffice import get_soffice_env, run_soffice, find_soffice
    except ImportError:
        return {"error": SOFFICE_MISSING}

    soffice_exe = find_soffice()
    if not soffice_exe:
        return {"error": SOFFICE_MISSING}

    started = time.monotonic()

    # Setup LibreOffice macro
    url = profile_dir.as_uri()
    try:
        run_soffice(
            ["--headless", "--terminate_after_init", f"-env:UserInstallation={url}"],
            capture_output=True,
            timeout=timeout,
        )
    except FileNotFoundError:
        return {"error": SOFFICE_MISSING}
    except subprocess.TimeoutExpired:
        return {"error": "LibreOffice timed out creating its profile; formulas were NOT recalculated"}

    macro_dir = profile_dir / "user" / "basic" / "Standard"
    if not macro_dir.exists():
        return {"error": "LibreOffice did not create a usable profile; formulas were NOT recalculated"}

    try:
        (macro_dir / MACRO_FILENAME).write_text(RECALCULATE_MACRO)
    except OSError as e:
        return {"error": f"Could not install the recalculation macro: {e}"}

    timeout = max(5, int(timeout - (time.monotonic() - started)))

    before = _stamp(abs_path)

    cmd = [
        soffice_exe,
        "--headless",
        "--norestore",
        f"-env:UserInstallation={url}",
        "vnd.sun.star.script:Standard.Module1.RecalculateAndSave?language=Basic&location=application",
        abs_path,
    ]

    if platform.system() == "Linux" and shutil.which("timeout"):
        cmd = ["timeout", str(timeout)] + cmd
    elif platform.system() == "Darwin":
        try:
            subprocess.run(["gtimeout", "--version"], capture_output=True, timeout=1, check=False)
            cmd = ["gtimeout", str(timeout)] + cmd
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass

    timed_out = f"LibreOffice timed out after {timeout}s; formulas were NOT recalculated. Re-run with a longer timeout."

    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, env=get_soffice_env(), timeout=timeout + 15
        )
    except subprocess.TimeoutExpired:
        return {"error": timed_out}
    except FileNotFoundError:
        return {"error": SOFFICE_MISSING}

    if result.returncode == 124:
        return {"error": timed_out}

    if result.returncode != 0:
        detail = (result.stderr or "").strip() or f"soffice exited {result.returncode}"
        return {"error": f"LibreOffice failed to recalculate: {detail}"}

    if _stamp(abs_path) == before:
        return {
            "error": (
                "LibreOffice exited cleanly but never rewrote the file, so nothing was "
                "recalculated. Check that no other LibreOffice instance is running, then retry."
            )
        }

    report = _verify_recalc(filename)
    if "error" not in report:
        report["mode"] = "cache"
        report["file_modified"] = True
    return report


def _verify_recalc(filename, formula_count=None):
    """Verify recalculation results and return JSON report (LibreOffice path).

    Two-pass load (formulas + cached values) so that ONLY cells that were
    formulas are checked against the error set. A plain text cell whose content
    happens to be exactly "#N/A" (or that merely mentions it) is never flagged,
    because text cells are not formula cells.
    """
    try:
        wb_formulas = load_workbook(filename, data_only=False)
        wb_values = load_workbook(filename, data_only=True)
        try:
            error_details = {err: [] for err in EXCEL_ERRORS}
            total_errors = 0
            counted_formulas = 0

            for sheet_name in wb_formulas.sheetnames:
                ws_f = wb_formulas[sheet_name]
                ws_v = wb_values[sheet_name]
                if not hasattr(ws_f, "iter_rows"):
                    continue
                for row_f, row_v in zip(ws_f.iter_rows(), ws_v.iter_rows()):
                    for cf, cv in zip(row_f, row_v):
                        v = cf.value
                        if not (isinstance(v, str) and v.startswith("=")):
                            continue  # not a formula cell — never an error
                        counted_formulas += 1
                        cached = cv.value
                        if not isinstance(cached, str):
                            continue
                        stripped = cached.strip()
                        for err in EXCEL_ERRORS:
                            if stripped == err:
                                location = f"{sheet_name}!{cf.coordinate}"
                                error_details[err].append(location)
                                total_errors += 1
                                break
        finally:
            wb_formulas.close()
            wb_values.close()

        result = {
            "status": "success" if total_errors == 0 else "errors_found",
            "total_errors": total_errors,
            "total_formulas": formula_count if formula_count is not None else counted_formulas,
            "error_summary": {},
        }

        for err_type, locations in error_details.items():
            if locations:
                entry = {"count": len(locations), "locations": locations[:MAX_LOCATIONS]}
                if len(locations) > MAX_LOCATIONS:
                    entry["locations_truncated"] = len(locations) - MAX_LOCATIONS
                result["error_summary"][err_type] = entry

        return result

    except Exception as e:
        return {"error": str(e)}


def main():
    argv = sys.argv[1:]
    force = "--force" in argv

    mode = "check"
    for flag, m in (("--bake", "bake"), ("--cache", "cache"), ("--check", "check")):
        if flag in argv:
            mode = m

    args = [a for a in argv if a not in ("--force", "--check", "--bake", "--cache")]

    if not args:
        print("Usage: python recalc.py <excel_file> [timeout_seconds] [mode] [--force]")
        print()
        print("Three modes (default: --check — the file is NEVER modified):")
        print("  --check   Validate formulas in memory with pycel, report errors.")
        print("            File untouched; formulas stay. Excel/WPS recompute on open.")
        print("  --bake    Evaluate with pycel and overwrite formulas with their values")
        print("            (static snapshot — formulas are LOST on purpose).")
        print("            Use only for one-off exports that will not be edited again.")
        print("  --cache   Write cached values while KEEPING formulas, via LibreOffice")
        print("            (optional, ~300MB; the only path that gives both).")
        print()
        print("Returns JSON:")
        print("  - mode: 'check' | 'bake' | 'cache' (actual engine used)")
        print("  - file_modified: true only when the file was rewritten")
        print("  - status: 'success' or 'errors_found'")
        print("  - total_errors: Total number of Excel errors found")
        print("  - total_formulas: Number of formulas in the file")
        print("  - error_summary: Breakdown by error type with locations")
        print("    - #VALUE!, #DIV/0!, #REF!, #NAME?, #NULL!, #NUM!, #N/A")
        print("  - unresolved_formulas (check/bake): formulas pycel could not evaluate")
        print()
        print("On any failure the JSON has an 'error' key and no 'status'.")
        print("--force (write modes only) recalculates even when it would destroy external links.")
        sys.exit(1)

    filename = args[0]
    timeout = int(args[1]) if len(args) > 1 else 30

    try:
        result = recalc(filename, timeout, force=force, mode=mode)
    except Exception as e:  # never let an unexpected error surface as a bare traceback
        result = {"error": f"Unexpected failure: {e!r}"}
    print(json.dumps(result, indent=2))
    sys.exit(1 if "error" in result else 0)


if __name__ == "__main__":
    main()
