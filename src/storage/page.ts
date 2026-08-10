export const PAGE_SIZE = 4096;
export const HEADER_MAGIC = 0x51554442; // "Q U D B"

export type PageType =
  | "free"
  | "table_header"
  | "table_page"
  | "btree_meta"
  | "btree_leaf"
  | "btree_internal";

export interface Page {
  id: number;
  type: PageType;
  data: Uint8Array;
}

export function allocPage(id: number, type: PageType): Page {
  return { id, type, data: new Uint8Array(PAGE_SIZE) };
}

export function setPageType(page: Page, type: PageType): void {
  page.type = type;
  // byte 0-3: page number, byte 4: type marker. Reserved for future on-disk format.
  const dv = new DataView(page.data.buffer);
  dv.setUint32(0, page.id, true);
  dv.setUint8(4, typeCode(type));
}

export function getPageType(data: Uint8Array): PageType {
  const dv = new DataView(data.buffer);
  return typeDecode(dv.getUint8(4));
}

function typeCode(t: PageType): number {
  switch (t) {
    case "free": return 0;
    case "table_header": return 1;
    case "table_page": return 2;
    case "btree_meta": return 3;
    case "btree_leaf": return 4;
    case "btree_internal": return 5;
  }
}

function typeDecode(c: number): PageType {
  switch (c) {
    case 0: return "free";
    case 1: return "table_header";
    case 2: return "table_page";
    case 3: return "btree_meta";
    case 4: return "btree_leaf";
    case 5: return "btree_internal";
    default: return "free";
  }
}

let COOKIE = 0;
export function pageCookie(): number {
  return COOKIE++;
}