/** The product name used in the browser title. */
export const PRODUCT_TITLE = "Omni Model";

/**
 * Build the route head metadata shared by every dashboard page.
 *
 * Keeping the format here makes browser tabs, history, and bookmarks consistent
 * while each leaf route still owns the name that identifies its screen.
 */
export function pageHead(page: string): { meta: [{ title: string }] } {
  return { meta: [{ title: `${page} | ${PRODUCT_TITLE}` }] };
}
