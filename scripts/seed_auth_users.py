#!/usr/bin/env python3
"""
MSMM Beacon — auth user seeder.

For every row in beacon.users with non-null email + first_name, ensures an
auth.users row exists with:
  * email          = beacon.users.email (lowercased)
  * password       = first_name + "123$"   (e.g. "Raj123$")
  * email_confirmed (no confirmation mail flow)
  * app_metadata   = { "role": beacon.users.role }

Idempotent: uses GET /auth/v1/admin/users?email=... to look up existing users
and PATCHes the password + metadata on match. Otherwise POSTs a new user.

  python3 scripts/seed_auth_users.py              # upsert all users
  python3 scripts/seed_auth_users.py --dry-run    # show what would happen
  python3 scripts/seed_auth_users.py --email X    # only this address

Requires SUPABASE_URL and SUPABASE_SERVICE_KEY in .env.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
if not URL or not KEY:
    sys.exit("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY in .env")

REST     = f"{URL}/rest/v1"
GOTRUE   = f"{URL}/auth/v1"

H_REST = {
    "apikey": KEY,
    "Authorization": f"Bearer {KEY}",
    "Accept-Profile": "beacon",
    "Content-Profile": "beacon",
    "Content-Type": "application/json",
}
H_AUTH = {
    "apikey": KEY,
    "Authorization": f"Bearer {KEY}",
    "Content-Type": "application/json",
}


def fetch_beacon_users() -> list[dict]:
    """Pull every seedable user row (email + first_name both present)."""
    params = {
        "select": "id,email,first_name,role",
        "email": "not.is.null",
        "first_name": "not.is.null",
    }
    r = requests.get(f"{REST}/users", headers=H_REST, params=params, timeout=30)
    if r.status_code >= 400:
        sys.exit(f"GET beacon.users failed: {r.status_code} {r.text[:500]}")
    return r.json()


def lookup_auth_user(email: str) -> dict | None:
    """
    Supabase GoTrue admin: GET /auth/v1/admin/users?email=<email>.
    Response shape differs across versions; handle both a bare list and
    {"users": [...]}.
    """
    r = requests.get(
        f"{GOTRUE}/admin/users",
        headers=H_AUTH,
        params={"email": email},
        timeout=30,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"admin lookup failed: {r.status_code} {r.text[:400]}")
    body = r.json()
    users = body.get("users") if isinstance(body, dict) else body
    if not users:
        return None
    # Some instances return ALL users (no server-side filter). Narrow on
    # our side to the exact email match.
    for u in users:
        if (u.get("email") or "").lower() == email.lower():
            return u
    return None


def create_auth_user(email: str, password: str, role: str) -> dict:
    body = {
        "email": email,
        "password": password,
        "email_confirm": True,
        "app_metadata": {"role": role, "provider": "email", "providers": ["email"]},
    }
    r = requests.post(f"{GOTRUE}/admin/users", headers=H_AUTH, json=body, timeout=30)
    if r.status_code >= 400:
        raise RuntimeError(f"create {email} failed: {r.status_code} {r.text[:400]}")
    return r.json()


def update_auth_user(user_id: str, password: str, role: str) -> dict:
    body = {
        "password": password,
        "email_confirm": True,
        "app_metadata": {"role": role, "provider": "email", "providers": ["email"]},
    }
    r = requests.put(
        f"{GOTRUE}/admin/users/{user_id}",
        headers=H_AUTH,
        json=body,
        timeout=30,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"update {user_id} failed: {r.status_code} {r.text[:400]}")
    return r.json()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="Print the plan without hitting GoTrue.")
    ap.add_argument("--email", help="Only process this single email (case-insensitive).")
    ap.add_argument("--force-password-reset", action="store_true",
                    help="PUT the password even when the user already exists (default: true).")
    args = ap.parse_args()

    rows = fetch_beacon_users()
    if args.email:
        needle = args.email.lower()
        rows = [r for r in rows if (r.get("email") or "").lower() == needle]
        if not rows:
            sys.exit(f"No beacon.users row matches email={args.email}")

    print(f"Will process {len(rows)} user(s)")
    created, updated, skipped = 0, 0, 0

    for row in rows:
        email = (row["email"] or "").lower().strip()
        first = (row["first_name"] or "").strip()
        role  = (row.get("role") or "User").strip() or "User"
        password = f"{first}123$"
        label = f"{email:<40} role={role:<5} pw={password}"

        if args.dry_run:
            print(f"  [dry]   {label}")
            continue

        existing = lookup_auth_user(email)
        if existing:
            update_auth_user(existing["id"], password, role)
            print(f"  updated {label}")
            updated += 1
        else:
            create_auth_user(email, password, role)
            print(f"  created {label}")
            created += 1

    print(f"\nDone · created={created} updated={updated} skipped={skipped}")


if __name__ == "__main__":
    main()
