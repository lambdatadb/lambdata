import type { SetAsideSchema } from "@lambdata/shared";

const HOUR = 3_600_000;

export function fixtureSetAside(now = Date.now()): SetAsideSchema[] {
  return [
    {
      schema: "_ld_quarantine_storefront_k3f9a2",
      kind: "quarantine",
      createdAt: now - 2 * HOUR,
      sizeBytes: 49_152,
      tables: [{ name: "orders", rowCount: 3, sizeBytes: 49_152, nameFreeInDatabase: false }],
    },
    {
      schema: "_ld_kept_storefront_7qp2xd",
      kind: "kept",
      createdAt: now - 26 * HOUR,
      sizeBytes: 212_992,
      tables: [
        { name: "customers", rowCount: 7, sizeBytes: 81_920, nameFreeInDatabase: true },
        { name: "order_items", rowCount: 1_204, sizeBytes: 131_072, nameFreeInDatabase: false },
      ],
    },
  ];
}
