#!/usr/bin/env python3
"""
Seed beacon_v2.leave_balances from the HR "Time off as of 5/27/26" spreadsheet.

Each row's Vacation balance / Vacation used / Sick balance / Sick used become the
user's opening figures, stamped as_of 2026-05-27. The live view
(v_leave_balances) accrues every pay period after that automatically, so the
June 3 paycheck (and every future one) shows without re-running this.

Name mapping is "Last, First M" → beacon_v2.users by (last, first); known
spelling variants are in OVERRIDES. Employees not in the DB are reported and
skipped (the roster has no Scott Inman / Mark Saucier / Ashley Smith Gibson).
accrues = (department <> '1099').

Requires migration 20260608170000 (leave_balances) applied first.

Usage:
    python3 scripts/seed_leave_balances.py            # dry-run (read-only)
    python3 scripts/seed_leave_balances.py --apply    # upserts leave_balances
"""
from __future__ import annotations

import os
import sys

import requests
import xlrd
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.getcwd(), ".env"))
URL = os.environ["SUPABASE_URL"]
KEY = os.environ["SUPABASE_SERVICE_KEY"]
XLS = os.environ.get("LEAVE_XLS", os.path.expanduser(
    "~/Downloads/Vacation & Sick Leave Balances.xls"))
AS_OF = "2026-05-27"

# Excel "Last, First" (normalized lower) → DB email, for rows the (last,first)
# match misses (spelling variants / HR-confirmed identities).
OVERRIDES = {
    ("le", "binh"): "binh@msmmeng.com",              # DB last name is "Li"
    ("inman", "scott"): "scott@msmmeng.com",         # Scott Inman = Scott Douglas (per HR)
    ("smith gibson", "ashley"): "agibson@msmmeng.com",  # added as Ashley Gibson (PM)
}

# Sheet rows intentionally NOT tracked (per HR direction).
IGNORE = {("saucier", "mark")}

H_READ = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Accept-Profile": "beacon_v2"}
H_WRITE = {**H_READ, "Content-Profile": "beacon_v2", "Content-Type": "application/json",
           "Prefer": "resolution=merge-duplicates,return=minimal"}


def norm(s):
    return (s or "").strip().lower()


def main():
    apply = "--apply" in sys.argv

    users = requests.get(
        f"{URL}/rest/v1/users", headers=H_READ,
        params={"select": "id,first_name,last_name,email,department"}, timeout=30,
    ).json()
    by_lf = {(norm(u["last_name"]), norm(u["first_name"])): u for u in users}
    by_email = {norm(u["email"]): u for u in users}

    sh = xlrd.open_workbook(XLS).sheet_by_index(0)

    def num(r, c):
        v = sh.cell_value(r, c)
        return float(v) if isinstance(v, (int, float)) and v != "" else 0.0

    payloads, missing = [], []
    print(f"{'Excel name':30s} {'→ user':22s} {'dept':22s}  vac_bal vac_used sick_bal sick_used")
    for r in range(5, sh.nrows):
        name = sh.cell_value(r, 0).strip()
        if not name:
            continue
        last, _, rest = name.partition(",")
        first = (rest.strip().split() or [""])[0]
        key = (norm(last), norm(first))

        if key in IGNORE:
            print(f"{name:30s} {'(ignored — per HR)':22s}")
            continue

        u = None
        if key in OVERRIDES:
            u = by_email.get(norm(OVERRIDES[key]))
        if not u:
            u = by_lf.get(key)
        if not u:
            cands = [x for x in users if norm(x["last_name"]) == norm(last)]
            u = cands[0] if len(cands) == 1 else None

        if not u:
            missing.append(name)
            print(f"{name:30s} {'*** NOT IN DB — skipped':22s}")
            continue

        dept = u.get("department") or ""
        vb, vu, sb, su = num(r, 2), num(r, 3), num(r, 5), num(r, 6)
        accrues = norm(dept) != "1099"
        print(f"{name:30s} {u['email']:22s} {dept:22s}  {vb:7.2f} {vu:8.2f} {sb:8.2f} {su:9.2f}"
              + ("" if accrues else "  [no-accrue]"))
        payloads.append({
            "user_id": u["id"], "vacation_balance": vb, "vacation_used": vu,
            "sick_balance": sb, "sick_used": su, "as_of_date": AS_OF, "accrues": accrues,
        })

    print(f"\nMapped {len(payloads)} / {sh.nrows - 5} rows. "
          f"Not in DB ({len(missing)}): {', '.join(missing) or 'none'}")

    if not apply:
        print("\nDry-run only. Re-run with --apply to upsert leave_balances.")
        return

    resp = requests.post(
        f"{URL}/rest/v1/leave_balances?on_conflict=user_id",
        headers=H_WRITE, json=payloads, timeout=60,
    )
    if resp.status_code >= 400:
        print(f"[FAIL] status={resp.status_code} body={resp.text[:300]}")
        sys.exit(1)
    print(f"Upserted {len(payloads)} leave_balances row(s).")


if __name__ == "__main__":
    main()
