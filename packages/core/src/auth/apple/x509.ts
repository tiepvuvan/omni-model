/**
 * Re-export of `@peculiar/x509` that guarantees the Reflect-metadata shim it
 * needs is installed first (ES module dependencies are evaluated in import
 * order, so the shim's side effect runs before the library loads). All Apple
 * attestation code must import x509 from here, never from the package
 * directly.
 */
import "./reflect-shim.js";

export * from "@peculiar/x509";
