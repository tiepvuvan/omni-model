/**
 * Types for Monaco's ESM entry points.
 *
 * `monaco-editor` ships types for the package root, which is the *bundle* — it
 * includes the TypeScript, CSS, HTML and JSON language services and their four
 * web workers, and importing it took the client bundle from 1MB to 14MB. The ESM
 * `editor.api` path is the editor alone, and has no `.d.ts` of its own, so it is
 * declared here as exporting exactly the root's API surface.
 */
declare module "monaco-editor/esm/vs/editor/editor.api" {
  export * from "monaco-editor";
}

/** Vite's `?worker` suffix: a constructor for the bundled worker. */
declare module "*?worker" {
  const WorkerConstructor: new () => Worker;
  export default WorkerConstructor;
}
