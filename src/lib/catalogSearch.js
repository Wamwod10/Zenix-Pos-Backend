/**
 * Literal substring search for the paged product API. PostgreSQL ILIKE treats
 * %, _ and backslash as pattern syntax; a cashier entering those characters
 * should not accidentally match the entire catalog.
 */
export function catalogSearchPattern(search) {
  return `%${String(search).replace(/[\\%_]/g, '\\$&')}%`;
}

export function addCatalogSearchFilter(params, search) {
  if (!search) return null;
  params.push(catalogSearchPattern(search));
  const patternIndex = params.length;
  params.push(search);
  const exactIndex = params.length;
  return `(p.name ILIKE $${patternIndex} ESCAPE '\\' OR p.sku ILIKE $${patternIndex} ESCAPE '\\' OR p.brand ILIKE $${patternIndex} ESCAPE '\\' OR p.category ILIKE $${patternIndex} ESCAPE '\\' OR p.barcode=$${exactIndex})`;
}
