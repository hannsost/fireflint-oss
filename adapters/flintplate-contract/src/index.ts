/** Internal types for the pinned FlintPlate v1 export; not runtime validation. */
export type PackagingV1 = {
  readonly name: string;
  readonly price_cents: number;
  readonly deposit_cents: number;
  readonly tax_rate_bps: number;
  readonly deposit_tax_rate_bps: number;
  readonly reusable: boolean;
};

export type MenuItemV1 = {
  readonly id: string;
  readonly sku: string;
  readonly version: number;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly price_cents: number;
  readonly tax_rate_bps: number;
  readonly allergens: readonly string[];
  readonly available: boolean;
  readonly station: string;
  readonly takeaway_packaging: PackagingV1 | null;
};

/** Producer-normalized payload: defaults/nulls are already present. */
export type MenuSnapshotV1 = {
  readonly schema_version: 1;
  readonly source_system: "flintplate";
  readonly venue_id: string;
  readonly menu_id: string;
  /** Opaque source hash; never use as FireFlint expected_revision. */
  readonly menu_revision: string;
  readonly currency: "EUR";
  readonly timezone: string;
  /** Preserve the original string, including microseconds. */
  readonly published_at: string;
  readonly items: readonly MenuItemV1[];
};

/** Structural wire types: JSON Schema defaults are not automatic mutation. */
export type PackagingV1Wire = Omit<PackagingV1, "deposit_cents" | "reusable"> &
  Partial<Pick<PackagingV1, "deposit_cents" | "reusable">> &
  Readonly<Record<string, unknown>>;

export type MenuItemV1Wire = Omit<MenuItemV1, "takeaway_packaging"> & {
  readonly takeaway_packaging?: PackagingV1Wire | null;
} & Readonly<Record<string, unknown>>;

export type MenuSnapshotV1Wire = Omit<
  MenuSnapshotV1,
  "schema_version" | "source_system" | "currency" | "items"
> &
  Partial<Pick<MenuSnapshotV1, "schema_version" | "source_system" | "currency">> & {
    readonly items: readonly MenuItemV1Wire[];
  };
