#!/usr/bin/env python3
"""
MSMM Beacon — PM backfill.

Parses the same CSV/xlsx files under Data/ that ingest_seed_data.py reads,
but only extracts the PM column and writes the matching rows into the
`*_pms` join tables. Two direct sources + derived sources:

  * Potential Projects Data/*.csv  → potential_project_pms
  * Invoice Cycle Data/*.csv       → anticipated_invoice_pms

For Awaiting Verdict / Awarded / Closed-Out — the source files have NO PM
column. We derive those PMs by joining to Potential on project_name
(case-insensitive). When a match is found AND the Potential row has a PM,
the same PM is copied to the awaiting/awarded/closed row.

Name-matching rules (raw CSV string → beacon.users.id):

  1. Split compound strings like "Chris/ Autumn" or "Scott / Jim" on '/' + ','
  2. Trim whitespace.
  3. Try case-insensitive match on short_name → first_name → display_name.
  4. Fall back to the MANUAL_OVERRIDES dict for nicknames / disambiguations.
  5. Unmatched names are reported but not fatal.

Usage:
  python3 scripts/backfill_pms.py             # write
  python3 scripts/backfill_pms.py --dry-run   # parse + match, no writes
"""
from __future__ import annotations

import argparse
import csv
import os
import re
import sys
from pathlib import Path

import requests
from dotenv import load_dotenv
from openpyxl import load_workbook

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "Data"
load_dotenv(ROOT / ".env")

URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
if not URL or not KEY:
    sys.exit("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY in .env")

REST = f"{URL}/rest/v1"
H_BASE = {
    "apikey": KEY,
    "Authorization": f"Bearer {KEY}",
    "Accept-Profile": "beacon",
    "Content-Profile": "beacon",
}
H_JSON = {**H_BASE, "Content-Type": "application/json"}


# --------------------------------------------------------------------------
# Nickname / disambiguation overrides.
# The raw CSVs use first-names or short forms; a handful don't map cleanly:
#
#   "Scott"     → ambiguous (Scott Douglas / Scott Chehardy). We default to
#                 Scott D. (sdouglas) which owns the most projects.
#   "Phil"      → Philip Meric (short_name is 'Phil' on his row — already
#                 matches, but we keep the override explicit for clarity).
#   "Chuck"     → Chuck Brannon — display_name is 'Brannon' while short_name
#                 is 'Chuck', so short_name already wins; kept for docs.
#
# Names NOT present in beacon.users today (legacy / external) are mapped to
# None so they're quietly dropped with a single-line warning.
# --------------------------------------------------------------------------
MANUAL_OVERRIDES: dict[str, str | None] = {
    "scott":   "sdouglas",      # default ambiguous "Scott" → Scott Douglas
    "phil":    "pmeric",
    "chuck":   "cbrannon",
    # Unmapped names in the CSVs — explicit None so we log each once.
    "ali":     None,
    "randy":   None,
    "jeff":    None,
    "raj":     "rmehta",
    "ryan":    "rroessler",
    "dani":    "dalexander",
    "cierra":  "cerwin",
    "chantrell":"ccarriere",
    "mike":    "mharden",
    "lee":     "lwalker",
    "dominque":"dsmith",
    "stephen": "sleonard",
    "steve":   "sbobeck",
    "george":  "ggrimes",
    "clay":    "cray",
    "binh":    "binh",
    "ben":     "bbertucci",
    "benjamin":"bbertucci",
    "patrick": "pmansfield",
    "eric":    "ecurson",
    "milan":   "milan",
    "mayank":  "mayank",
    "manish":  "manish",
    "mark":    "mwingate",
    "autumn":  "arichards",
    "jim":     "jwilson",
    "stuart":  "sseiler",
    "chris":   "cmills",
}


# --------------------------------------------------------------------------
# HTTP helpers (same shape as ingest_seed_data.py)
# --------------------------------------------------------------------------
def fetch_all(path: str, select: str = "*", params_extra=None):
    rows, offset, page = [], 0, 1000
    params_base = {"select": select}
    if params_extra:
        params_base.update(params_extra)
    while True:
        params = dict(params_base)
        params["limit"] = page
        params["offset"] = offset
        r = requests.get(f"{REST}/{path}", headers=H_BASE, params=params, timeout=60)
        if r.status_code >= 400:
            raise RuntimeError(f"GET {path}: {r.status_code}: {r.text[:400]}")
        data = r.json()
        rows.extend(data)
        if len(data) < page:
            break
        offset += page
    return rows


def insert_rows(table: str, payload: list[dict]):
    if not payload:
        return 0
    # Composite-PK joins; ignore duplicates rather than error.
    r = requests.post(
        f"{REST}/{table}",
        headers={**H_JSON, "Prefer": "resolution=ignore-duplicates,return=representation"},
        json=payload,
        timeout=60,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"INSERT {table}: {r.status_code}: {r.text[:400]}")
    try:
        return len(r.json())
    except Exception:
        return len(payload)


# --------------------------------------------------------------------------
# CSV reading — handle BOM cleanly
# --------------------------------------------------------------------------
def read_csv(path: Path):
    with path.open(encoding="utf-8-sig") as fp:
        return list(csv.reader(fp))


# --------------------------------------------------------------------------
# Name resolver
# --------------------------------------------------------------------------
class Resolver:
    """Turns raw PM strings into a set of user_ids."""

    def __init__(self, users: list[dict]):
        self.users = users
        self.by_short   = {(u.get("short_name")   or "").lower(): u["id"] for u in users if u.get("short_name")}
        self.by_first   = {(u.get("first_name")   or "").lower(): u["id"] for u in users if u.get("first_name")}
        self.by_display = {(u.get("display_name") or "").lower(): u["id"] for u in users if u.get("display_name")}
        self.by_login   = {(u.get("login_name")   or "").lower(): u["id"] for u in users if u.get("login_name")}
        self.unmatched: dict[str, int] = {}

    def resolve(self, raw: str | None) -> list[str]:
        """Return list of user_ids for a raw PM string (may be compound)."""
        if not raw:
            return []
        # Split compound forms: "Chris/ Autumn", "Scott / Jim", "Mark, Autumn"
        parts = re.split(r"[\/\n,]+", raw)
        ids: list[str] = []
        seen = set()
        for raw_part in parts:
            name = raw_part.strip()
            if not name:
                continue
            uid = self._one(name)
            if uid and uid not in seen:
                ids.append(uid); seen.add(uid)
        return ids

    def _one(self, name: str) -> str | None:
        key = name.lower()
        # Manual overrides take precedence (handles "Scott" ambiguity + nicknames)
        if key in MANUAL_OVERRIDES:
            login = MANUAL_OVERRIDES[key]
            if login is None:
                self.unmatched[name] = self.unmatched.get(name, 0) + 1
                return None
            uid = self.by_login.get(login.lower())
            if uid: return uid
        # Exact short_name
        if key in self.by_short: return self.by_short[key]
        # Exact first_name
        if key in self.by_first: return self.by_first[key]
        # Exact display_name
        if key in self.by_display: return self.by_display[key]
        # Give up
        self.unmatched[name] = self.unmatched.get(name, 0) + 1
        return None


# --------------------------------------------------------------------------
# Parsers — minimal, only extract what we need for PM backfill
# --------------------------------------------------------------------------
def parse_potential_pms(path: Path, year: int, is_2026: bool) -> list[tuple[str, str]]:
    """Returns [(project_name, raw_pm_string), ...] for one potential CSV."""
    rows = read_csv(path)
    # Locate the "Project Name" header
    hdr_i = next(
        (i for i, r in enumerate(rows) if r and r[0].strip().lower() == "project name"),
        None,
    )
    if hdr_i is None:
        return []
    out = []
    pm_col = 9 if is_2026 else 4    # 2026 PM is col 9; 2025 PM is col 4
    for r in rows[hdr_i + 1:]:
        if not r:
            continue
        name = (r[0] or "").strip()
        if not name:
            continue
        # Skip section-total rows from the CSV (they carry subtotals, not data)
        if name.lower().startswith("total amount"):
            continue
        if len(r) <= pm_col:
            continue
        pm_raw = (r[pm_col] or "").strip()
        if pm_raw:
            out.append((name, pm_raw))
    return out


def parse_invoice_pms(path: Path, year: int) -> list[tuple[str, str, str | None]]:
    """Returns [(project_name, raw_pm_string, project_number), ...]."""
    rows = read_csv(path)
    hdr_i = next(
        (i for i, r in enumerate(rows) if r and (r[0] or "").strip() == "Project No."),
        None,
    )
    if hdr_i is None:
        return []
    out = []
    for r in rows[hdr_i + 1:]:
        if len(r) < 3:
            continue
        project_number = (r[0] or "").strip() or None
        project_name   = (r[1] or "").strip()
        pm_raw         = (r[2] or "").strip()
        if not project_name:
            continue
        upper = project_name.upper()
        if upper in ("ENG PROJECTS", "PM PROJECTS"):
            continue
        if upper.startswith("TOTAL"):
            continue
        if (project_number or "").upper().startswith("TOTAL"):
            continue
        if project_name.startswith("*") or "Not Included" in project_name:
            continue
        if project_number and re.fullmatch(r"\d{4}[Xx]+", project_number):
            project_number = None
        if not pm_raw:
            continue
        out.append((project_name, pm_raw, project_number))
    return out


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="Parse + match only; skip all writes.")
    args = ap.parse_args()

    print("Fetching users + existing project rows…")
    users     = fetch_all("users",
                          select="id,email,first_name,short_name,display_name,login_name")
    potential = fetch_all("potential_projects",
                          select="id,year,project_name,project_number")
    awaiting  = fetch_all("awaiting_verdict",
                          select="id,year,project_name")
    awarded   = fetch_all("awarded_projects",
                          select="id,year,project_name")
    closed    = fetch_all("closed_out_projects",
                          select="id,year,project_name")
    invoice   = fetch_all("anticipated_invoice",
                          select="id,year,project_name,project_number")

    print(f"  users={len(users)}  potential={len(potential)}  awaiting={len(awaiting)}")
    print(f"  awarded={len(awarded)}  closed={len(closed)}  invoice={len(invoice)}")

    resolver = Resolver(users)

    # ----- Potential -----
    pm_by_key_potential: dict[tuple[int, str], list[str]] = {}
    pot_pm_payload = []
    for path, year, is_2026 in [
        (DATA / "Potential Projects Data/2025 Year-to-Date Contract Status.csv", 2025, False),
        (DATA / "Potential Projects Data/2026 Year-to-Date Contract Status.csv", 2026, True),
    ]:
        if not path.exists():
            print(f"  skip missing {path}")
            continue
        items = parse_potential_pms(path, year, is_2026)
        pot_by_key = {(p["year"], p["project_name"].lower()): p["id"] for p in potential}
        for name, pm_raw in items:
            pid = pot_by_key.get((year, name.lower()))
            if not pid:
                continue
            user_ids = resolver.resolve(pm_raw)
            for uid in user_ids:
                pot_pm_payload.append({"potential_project_id": pid, "user_id": uid})
            # Remember for cross-copy later
            if user_ids:
                pm_by_key_potential[(year, name.lower())] = user_ids
    # Dedup composite PK
    pot_pm_payload = list({(p["potential_project_id"], p["user_id"]): p for p in pot_pm_payload}.values())
    print(f"\nPotential PM rows: {len(pot_pm_payload)}")

    # ----- Invoice -----
    inv_pm_payload = []
    inv_by_name  = {(i["year"], (i["project_name"] or "").lower()): i["id"] for i in invoice}
    inv_by_num   = {((i["project_number"] or "").strip(), i["year"]): i["id"] for i in invoice if i["project_number"]}
    pm_by_proj_number: dict[str, list[str]] = {}
    for path, year in [
        (DATA / "Invoice Cycle Data/Year 2025 Anticipated Invoice Cycle-ENG.csv", 2025),
        (DATA / "Invoice Cycle Data/Year 2026Anticipated Invoice Cycle-ENG.csv", 2026),
    ]:
        if not path.exists():
            print(f"  skip missing {path}")
            continue
        items = parse_invoice_pms(path, year)
        for name, pm_raw, proj_num in items:
            iid = None
            if proj_num:
                iid = inv_by_num.get((proj_num, year))
            if not iid:
                iid = inv_by_name.get((year, name.lower()))
            user_ids = resolver.resolve(pm_raw)
            if iid:
                for uid in user_ids:
                    inv_pm_payload.append({"anticipated_invoice_id": iid, "user_id": uid})
            if proj_num and user_ids:
                pm_by_proj_number[proj_num] = user_ids
    inv_pm_payload = list({(p["anticipated_invoice_id"], p["user_id"]): p for p in inv_pm_payload}.values())
    print(f"Invoice PM rows:   {len(inv_pm_payload)}")

    # ----- Awaiting / Awarded / Closed: derive via project_name ⟷ Potential -----
    def derive_pms_for(rows: list[dict]) -> list[tuple[str, list[str]]]:
        """Returns [(row_id, user_ids), ...]. Rows with no PM source are skipped."""
        out = []
        for r in rows:
            key = (r["year"], (r["project_name"] or "").lower())
            uids = pm_by_key_potential.get(key)
            if not uids:
                # Secondary: any potential row with the same project_name regardless of year
                for k, v in pm_by_key_potential.items():
                    if k[1] == key[1]:
                        uids = v
                        break
            if uids:
                out.append((r["id"], uids))
        return out

    aw_derived = derive_pms_for(awaiting)
    awp_derived = derive_pms_for(awarded)
    cls_derived = derive_pms_for(closed)

    aw_pm_payload  = [{"awaiting_verdict_id": rid,   "user_id": uid} for rid, uids in aw_derived for uid in uids]
    awp_pm_payload = [{"awarded_project_id": rid,    "user_id": uid} for rid, uids in awp_derived for uid in uids]
    cls_pm_payload = [{"closed_out_project_id": rid, "user_id": uid} for rid, uids in cls_derived for uid in uids]

    print(f"Awaiting PM rows:  {len(aw_pm_payload)} (from {len(aw_derived)} projects)")
    print(f"Awarded PM rows:   {len(awp_pm_payload)} (from {len(awp_derived)} projects)")
    print(f"Closed PM rows:    {len(cls_pm_payload)} (from {len(cls_derived)} projects)")

    # ----- Unmatched names report -----
    if resolver.unmatched:
        print("\nUnmatched PM names (appeared in CSVs but not in beacon.users):")
        for name, count in sorted(resolver.unmatched.items(), key=lambda kv: -kv[1]):
            print(f"  {name:<20} x{count}")

    if args.dry_run:
        print("\n--dry-run: no writes.")
        return

    # ----- Writes -----
    print("\nWriting PM join rows…")
    n = insert_rows("potential_project_pms",  pot_pm_payload);  print(f"  potential_project_pms   +{n}")
    n = insert_rows("awaiting_verdict_pms",   aw_pm_payload);   print(f"  awaiting_verdict_pms    +{n}")
    n = insert_rows("awarded_project_pms",    awp_pm_payload);  print(f"  awarded_project_pms     +{n}")
    n = insert_rows("closed_out_project_pms", cls_pm_payload);  print(f"  closed_out_project_pms  +{n}")
    n = insert_rows("anticipated_invoice_pms", inv_pm_payload); print(f"  anticipated_invoice_pms +{n}")

    print("\nDone.")


if __name__ == "__main__":
    main()
