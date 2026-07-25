/**
 * The narrowest thing a factory's `optionsSchema` has to be.
 *
 * Deliberately structural rather than `z.ZodType`: a factory in another package
 * may be built against a different zod minor, and a nominal type would make
 * those versions incompatible for a field that exists only to be described. The
 * admin API converts it with `z.toJSONSchema`, which accepts any zod schema.
 */
export interface ZodTypeLike {
  readonly _zod: unknown;
}
