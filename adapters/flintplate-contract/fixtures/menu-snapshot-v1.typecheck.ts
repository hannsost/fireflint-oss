// Generated synthetic vector. Rebuild with tools/generate-fixture.py.
import type { MenuSnapshotV1 } from "../src/index.js";

export const snapshot = {
  "schema_version": 1,
  "source_system": "flintplate",
  "venue_id": "10000000-0000-4000-8000-000000000001",
  "menu_id": "10000000-0000-4000-8000-000000000001",
  "menu_revision": "e44ae9ad5a754dca8713b109b53f35db4af55078cc741680334287a94c81fd33",
  "currency": "EUR",
  "timezone": "Europe/Berlin",
  "published_at": "2026-09-11T00:00:00.123456Z",
  "items": [
    {
      "id": "00000000-0000-4000-8000-000000000002",
      "sku": "A-1",
      "version": 3,
      "name": "Crème brûlée 🍮",
      "description": "Größe: groß\n\"Spezial\" / \\ ",
      "category": "Desserts",
      "price_cents": 750,
      "tax_rate_bps": 1900,
      "allergens": [
        "milk",
        "eggs"
      ],
      "available": false,
      "station": "kitchen",
      "takeaway_packaging": null
    },
    {
      "id": "00000000-0000-4000-8000-000000000003",
      "sku": "A.1",
      "version": 3,
      "name": "Crème brûlée 🍮",
      "description": "Größe: groß\n\"Spezial\" / \\ ",
      "category": "Desserts",
      "price_cents": 750,
      "tax_rate_bps": 1900,
      "allergens": [
        "milk",
        "eggs"
      ],
      "available": true,
      "station": "kitchen",
      "takeaway_packaging": {
        "name": "Pfandglas",
        "price_cents": 50,
        "deposit_cents": 200,
        "tax_rate_bps": 700,
        "deposit_tax_rate_bps": 1900,
        "reusable": true
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000001",
      "sku": "a_1",
      "version": 3,
      "name": "Crème brûlée 🍮",
      "description": "Größe: groß\n\"Spezial\" / \\ ",
      "category": "Desserts",
      "price_cents": 750,
      "tax_rate_bps": 1900,
      "allergens": [
        "milk",
        "eggs"
      ],
      "available": true,
      "station": "kitchen",
      "takeaway_packaging": {
        "name": "Mehrwegbecher ☕",
        "price_cents": 35,
        "deposit_cents": 0,
        "tax_rate_bps": 1900,
        "deposit_tax_rate_bps": 0,
        "reusable": false
      }
    }
  ]
} as const satisfies MenuSnapshotV1;
