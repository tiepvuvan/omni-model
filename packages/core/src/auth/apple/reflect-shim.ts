/**
 * Minimal Reflect-metadata polyfill required by `@peculiar/x509` (via
 * tsyringe), which refuses to load when `Reflect.getMetadata` is absent.
 * Installing the full `reflect-metadata` package would be another global
 * side effect anyway; this WeakMap-backed shim covers the small surface
 * tsyringe touches (zero-argument constructor registrations only) and is a
 * no-op when a real polyfill is already present.
 *
 * Import this module (for its side effect) before importing `@peculiar/x509`.
 */

type MetadataStore = WeakMap<
  object,
  Map<string | symbol, Map<string | symbol | undefined, unknown>>
>;

const reflect = Reflect as unknown as Record<string, unknown>;

if (typeof reflect.getMetadata !== "function") {
  const store: MetadataStore = new WeakMap();

  const bucket = (
    target: object,
    propertyKey: string | symbol | undefined,
    create: boolean,
  ): Map<string | symbol | undefined, unknown> | undefined => {
    let byKey = store.get(target);
    if (byKey === undefined) {
      if (!create) return undefined;
      byKey = new Map();
      store.set(target, byKey);
    }
    const slot = propertyKey ?? "";
    let metadata = byKey.get(slot);
    if (metadata === undefined && create) {
      metadata = new Map();
      byKey.set(slot, metadata);
    }
    return metadata;
  };

  reflect.defineMetadata = (
    metadataKey: string | symbol,
    metadataValue: unknown,
    target: object,
    propertyKey?: string | symbol,
  ): void => {
    bucket(target, propertyKey, true)?.set(metadataKey, metadataValue);
  };
  reflect.getMetadata = (
    metadataKey: string | symbol,
    target: object,
    propertyKey?: string | symbol,
  ): unknown => bucket(target, propertyKey, false)?.get(metadataKey);
  reflect.getOwnMetadata = reflect.getMetadata;
  reflect.hasMetadata = (
    metadataKey: string | symbol,
    target: object,
    propertyKey?: string | symbol,
  ): boolean => bucket(target, propertyKey, false)?.has(metadataKey) ?? false;
  reflect.hasOwnMetadata = reflect.hasMetadata;
  reflect.metadata =
    (metadataKey: string | symbol, metadataValue: unknown) =>
    (target: object, propertyKey?: string | symbol): void => {
      bucket(target, propertyKey, true)?.set(metadataKey, metadataValue);
    };
}
