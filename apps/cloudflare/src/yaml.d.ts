/**
 * Wrangler bundles `.yaml` files as Text modules (see the `rules` block in
 * the root wrangler.jsonc); this declaration mirrors that for TypeScript.
 */
declare module "*.yaml" {
  const text: string;
  export default text;
}
