#!/usr/bin/env python3
"""
One-shot: NULL out anticipated_invoice.ytd_actual_override +
rollforward_override on every row in beacon_v2 so the frontend's
auto-calc (sum of all 12 months / remainingStart − YTD) shows live.

Run after the YTD-Actual / Rollforward auto-calc formula change so the
displayed numbers reflect the new sum-of-Jan-through-Dec rule instead
of stale overrides written under the old "Jan–current-month" formula.

Usage:
    python3 scripts/clear_invoice_overrides.py            # dry-run
    python3 scripts/clear_invoice_overrides.py --apply    # writes
"""
from __future__ import annotations

import os
import sys

import requests
from dotenv import load_dotenv

load_dotenv()
URL = os.environ["SUPABASE_URL"]
KEY = os.environ["SUPABASE_SERVICE_KEY"]

H_READ = {
    "apikey": KEY,
    "Authorization": f"Bearer {KEY}",
    "Accept-Profile": "beacon_v2",
}
H_WRITE = {
    **H_READ,
    "Content-Profile": "beacon_v2",
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}


def main():
    apply = "--apply" in sys.argv

    # Count rows that currently carry a non-null override on either column.
    r = requests.get(
        f"{URL}/rest/v1/anticipated_invoice",
        headers=H_READ,
        params={
            "select": "id,project_name,year,ytd_actual_override,rollforward_override",
            "or": "(ytd_actual_override.not.is.null,rollforward_override.not.is.null)",
        },
        timeout=30,
    )
    r.raise_for_status()
    rows = r.json()

    print(f"Found {len(rows)} invoice row(s) with stored YTD / Rollforward overrides.")
    for row in rows[:25]:
        print(
            f"  · {row.get('year') or '----'} · {row.get('project_name') or '(no name)':40s}"
            f"  ytd={row.get('ytd_actual_override')!r:>12}"
            f"  rf={row.get('rollforward_override')!r:>12}"
        )
    if len(rows) > 25:
        print(f"  … and {len(rows) - 25} more")

    if not apply:
        print()
        print("Dry-run only. Re-run with --apply to NULL out these overrides.")
        return

    if not rows:
        print("Nothing to clear.")
        return

    # PATCH each row to NULL both override columns. Could be done as a single
    # range PATCH with a filter, but iterating is simpler and gives us a
    # success counter for the audit log.
    cleared = 0
    for row in rows:
        rr = requests.patch(
            f"{URL}/rest/v1/anticipated_invoice",
            headers=H_WRITE,
            params={"id": f"eq.{row['id']}"},
            json={"ytd_actual_override": None, "rollforward_override": None},
            timeout=30,
        )
        if rr.status_code >= 400:
            print(f"  [FAIL] id={row['id']} status={rr.status_code} body={rr.text[:120]}")
            continue
        cleared += 1

    print(f"Cleared overrides on {cleared} / {len(rows)} row(s).")


if __name__ == "__main__":
    main()
