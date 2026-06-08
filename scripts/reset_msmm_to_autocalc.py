#!/usr/bin/env python3
"""
One-shot: NULL out the MSMM override columns on every anticipated_invoice row
in beacon_v2 so the frontend's auto-calc governs every project's MSMM values:

    MSMM portion  = Total Contract Value − Σ (kind='sub') sub contract amounts
    MSMM month i  = month total[i]      − Σ (kind='sub') sub month[i] amounts
    (no subs → Total − 0 = Total)

The app already computes exactly this live whenever the stored override is NULL
(msmmContractAuto / msmmAtDesc in tables.jsx, subtracting only kind='sub').
Clearing the overrides therefore makes MSMM = Total − subs for EVERY project and
keeps it correct as totals / subs change — unlike freezing a computed value,
which would go stale on the next edit.

Columns cleared (13): msmm_amount + msmm_{jan..dec}_amount.
NOT touched: msmm_remaining_to_bill_year_start (a billing-progress starting
balance, not "Total − subs"), ytd_actual_override / rollforward_override.

Requires the corrected MSMM guard (migration 20260608160000) to be applied
first — the original guard (20260608150000) rejected the service-role too, so
--apply 403s ("Only an administrator can edit MSMM values") until then. The
160000 migration also performs this same reset once, so this script is mainly a
re-runnable maintenance tool after the fact.

Usage:
    python3 scripts/reset_msmm_to_autocalc.py            # dry-run (read-only)
    python3 scripts/reset_msmm_to_autocalc.py --apply    # writes (NULLs them)
"""
from __future__ import annotations

import os
import sys

import requests
from dotenv import load_dotenv

load_dotenv()
URL = os.environ["SUPABASE_URL"]
KEY = os.environ["SUPABASE_SERVICE_KEY"]

MONTHS = ["jan", "feb", "mar", "apr", "may", "jun",
          "jul", "aug", "sep", "oct", "nov", "dec"]
MSMM_COLS = ["msmm_amount"] + [f"msmm_{m}_amount" for m in MONTHS]

H_READ = {
    "apikey": KEY,
    "Authorization": f"Bearer {KEY}",
    "Accept-Profile": "beacon_v2",
}
H_WRITE = {
    **H_READ,
    "Content-Profile": "beacon_v2",
    "Content-Type": "application/json",
    "Prefer": "return=minimal",
}


def main():
    apply = "--apply" in sys.argv

    or_filter = "(" + ",".join(f"{c}.not.is.null" for c in MSMM_COLS) + ")"
    r = requests.get(
        f"{URL}/rest/v1/anticipated_invoice",
        headers=H_READ,
        params={"select": "id,project_name,year," + ",".join(MSMM_COLS), "or": or_filter},
        timeout=30,
    )
    r.raise_for_status()
    rows = r.json()

    print(f"Found {len(rows)} invoice row(s) carrying at least one stored MSMM override.")
    for row in rows[:30]:
        overs = [c.replace("msmm_", "").replace("_amount", "")
                 for c in MSMM_COLS if row.get(c) is not None]
        print(f"  · {row.get('year') or '----'} · {(row.get('project_name') or '(no name)')[:42]:42s}"
              f"  set: {', '.join(overs)}")
    if len(rows) > 30:
        print(f"  … and {len(rows) - 30} more")

    if not apply:
        print("\nDry-run only. Re-run with --apply to NULL these overrides "
              "(every MSMM value then shows Total − subs, live).")
        return
    if not rows:
        print("Nothing to clear — all MSMM values already auto-calc (Total − subs).")
        return

    null_patch = {c: None for c in MSMM_COLS}
    cleared = 0
    for row in rows:
        rr = requests.patch(
            f"{URL}/rest/v1/anticipated_invoice",
            headers=H_WRITE,
            params={"id": f"eq.{row['id']}"},
            json=null_patch,
            timeout=30,
        )
        if rr.status_code >= 400:
            print(f"  [FAIL] id={row['id']} status={rr.status_code} body={rr.text[:140]}")
            continue
        cleared += 1

    print(f"Cleared MSMM overrides on {cleared} / {len(rows)} row(s). "
          f"Every project's MSMM now auto-calcs as Total − subs.")


if __name__ == "__main__":
    main()
