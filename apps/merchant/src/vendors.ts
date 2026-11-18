// The demo vendors: what a team at a mid-sized company buys every week.
// Shared by the demo stores and by `pnpm setup:stores`, which opens a Mandate
// account for each verified vendor and lists it in the vendor directory.
export interface Item { id: string; title: string; price: string }
export interface VendorConfig {
  slug: string;
  name: string;
  domain: string;
  /** Shown in Mandate's vendor directory and in spending reports. */
  category: string;
  /** What the buyer hears after paying. */
  delivery: string;
  /** Name of the look-alike's real counterpart. A look-alike has no Mandate account, so it is never verified. */
  looksLike?: string;
  items: Item[];
}

export const vendors: VendorConfig[] = [
  {
    slug: "seatwise",
    name: "Seatwise",
    domain: "seatwise.example",
    category: "Software",
    delivery: "Seats are active now",
    items: [
      { id: "tracker-seat", title: "Project tracker, 1 seat for a month", price: "12.00" },
      { id: "design-seat", title: "Design tool, 1 seat for a month", price: "15.00" },
      { id: "password-manager", title: "Password manager, 10 seats for a month", price: "40.00" },
      { id: "annual-plan", title: "Project tracker annual plan, 25 seats", price: "2400.00" },
    ],
  },
  {
    slug: "paperline",
    name: "Paperline Supply",
    domain: "paperlinesupply.example",
    category: "Office supplies",
    delivery: "Ships in 2 business days",
    items: [
      { id: "labels", title: "Shipping labels, 1,000", price: "22.00" },
      { id: "copy-paper", title: "Copy paper, 10 reams", price: "48.00" },
      { id: "toner", title: "Printer toner, black", price: "79.00" },
      { id: "desk", title: "Standing desk", price: "420.00" },
    ],
  },
  {
    slug: "cloudhaven",
    name: "Cloudhaven",
    domain: "cloudhaven.example",
    category: "Cloud and APIs",
    delivery: "Credits added to your account",
    items: [
      { id: "maps-api", title: "Maps API, 10,000 route lookups", price: "18.00" },
      { id: "storage", title: "File storage, 1 TB for a month", price: "23.00" },
      { id: "sms", title: "SMS credits, 5,000 messages", price: "35.00" },
    ],
  },
  {
    slug: "paperline-suply",
    name: "Paperline Suply",
    domain: "paperlinesuply.example",
    category: "Office supplies",
    delivery: "Ships soon",
    looksLike: "Paperline Supply",
    items: [
      { id: "labels", title: "Shipping labels, 1,000", price: "14.00" },
      { id: "copy-paper", title: "Copy paper, 10 reams", price: "31.00" },
      { id: "toner", title: "Printer toner, black", price: "52.00" },
    ],
  },
];

/** The .env setting that holds a vendor's Stellar address. */
export const addressSetting = (vendor: VendorConfig) => vendor.looksLike ? "STORE_LOOKALIKE_ADDRESS" : `STORE_${vendor.slug.toUpperCase()}_ADDRESS`;
/** The .env setting that holds a verified vendor's test login. */
export const passwordSetting = (vendor: VendorConfig) => `STORE_${vendor.slug.toUpperCase()}_PASSWORD`;
