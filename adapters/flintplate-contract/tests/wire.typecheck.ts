import type {
  MenuSnapshotV1,
  MenuSnapshotV1Wire,
  MenuItemV1Wire,
  PackagingV1Wire,
} from "../src/index.js";
import { snapshot } from "../fixtures/menu-snapshot-v1.typecheck.js";

export const normalized: MenuSnapshotV1 = snapshot;
export const normalizedIsWire: MenuSnapshotV1Wire = normalized;
const { takeaway_packaging: packaging, ...itemWithoutPackaging } = snapshot.items[1];
export const omittedItemDefault: MenuItemV1Wire = itemWithoutPackaging;
export const normalizedPackagingIsWire: PackagingV1Wire = packaging;
export const omittedDefaults: MenuSnapshotV1Wire = {
  venue_id: snapshot.venue_id,
  menu_id: snapshot.menu_id,
  menu_revision: snapshot.menu_revision,
  timezone: snapshot.timezone,
  published_at: snapshot.published_at,
  items: snapshot.items,
};
export const packagingWire: PackagingV1Wire = {
  name: "Becher",
  price_cents: 35,
  tax_rate_bps: 1900,
  deposit_tax_rate_bps: 0,
  unknown_field: "Structurally allowed; producer normalization ignores this.",
};

// @ts-expect-error v1 exports EUR only.
export const wrongCurrency: MenuSnapshotV1 = { ...snapshot, currency: "USD" };
// @ts-expect-error FireFlint numeric revisions cannot replace source hashes.
export const wrongRevision: MenuSnapshotV1 = { ...snapshot, menu_revision: 2 };
// @ts-expect-error Keep timestamp strings, including submillisecond precision.
export const wrongTimestamp: MenuSnapshotV1 = { ...snapshot, published_at: new Date() };
