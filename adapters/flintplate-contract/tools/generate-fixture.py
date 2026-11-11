"""Synthetic Python golden vector; imports no app, database, or configuration."""
from pathlib import Path
import hashlib
import json
import sys

ROOT = Path(__file__).resolve().parents[1]


def item(suffix: str, sku: str) -> dict:
    return {
        "id": f"00000000-0000-4000-8000-{suffix:0>12}",
        "sku": sku,
        "version": 3,
        "name": "Crème brûlée 🍮",
        "description": 'Größe: groß\n"Spezial" / \\ \x7f',
        "category": "Desserts",
        "price_cents": 750,
        "tax_rate_bps": 1900,
        "allergens": ["milk", "eggs"],
        "available": True,
        "station": "kitchen",
        "takeaway_packaging": None,
    }


items = [item("1", "a_1"), item("2", "A-1"), item("3", "A.1")]
items[0]["takeaway_packaging"] = {
    "name": "Mehrwegbecher ☕",
    "price_cents": 35,
    "deposit_cents": 0,
    "tax_rate_bps": 1900,
    "deposit_tax_rate_bps": 0,
    "reusable": False,
}
items[1]["available"] = False
items[2]["takeaway_packaging"] = {
    "name": "Pfandglas",
    "price_cents": 50,
    "deposit_cents": 200,
    "tax_rate_bps": 700,
    "deposit_tax_rate_bps": 1900,
    "reusable": True,
}
items.sort(key=lambda value: value["sku"])
canonical = json.dumps(items, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
snapshot = {
    "schema_version": 1,
    "source_system": "flintplate",
    "venue_id": "10000000-0000-4000-8000-000000000001",
    "menu_id": "10000000-0000-4000-8000-000000000001",
    "menu_revision": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
    "currency": "EUR",
    "timezone": "Europe/Berlin",
    "published_at": "2026-09-11T00:00:00.123456Z",
    "items": items,
}
serialized = json.dumps(snapshot, ensure_ascii=False, indent=2)
files = {
    "menu-snapshot-v1.json": (serialized + "\n").encode(),
    "menu-items-v1.canonical.json": canonical.encode("utf-8"),
    "menu-snapshot-v1.typecheck.ts": (
        '// Generated synthetic vector. Rebuild with tools/generate-fixture.py.\n'
        'import type { MenuSnapshotV1 } from "../src/index.js";\n\n'
        f"export const snapshot = {serialized} as const satisfies MenuSnapshotV1;\n"
    ).encode(),
}
for name, data in files.items():
    destination = ROOT / "fixtures" / name
    if "--check" in sys.argv:
        if destination.read_bytes() != data:
            raise SystemExit(f"Golden vector changed: {name}")
    else:
        destination.write_bytes(data)
print("Python golden vector:", snapshot["menu_revision"])
