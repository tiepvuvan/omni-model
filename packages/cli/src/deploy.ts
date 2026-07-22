import { spawn } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { confirm, isCancel, log, note, spinner } from "@clack/prompts";
import type { Answers } from "./config.js";
import { envVarsFor } from "./config.js";
import { TARGETS } from "./targets.js";

/**
 * Deploy actions per target.
 *
 * Cloudflare and Docker are driven end-to-end; the other container targets
 * print the exact commands instead of pretending to automate an account setup
 * we can't see. Every path is explicit about what it is about to run before it
 * runs it — a deploy is not something to do behind someone's back.
 */

const REPO = process.env.OMNI_MODEL_REPO ?? "tiepvuvan/omni-model";
/**
 * Overrides for developing the CLI itself, before (or instead of) a release:
 *   OMNI_MODEL_ARTIFACTS  a directory holding worker.js + wrangler.jsonc, used
 *                         instead of downloading them from a release
 *   OMNI_MODEL_IMAGE      a container image ref, e.g. a locally built one
 *   OMNI_MODEL_REPO       point at your fork
 * See packages/cli/README.md.
 */
const LOCAL_ARTIFACTS = process.env.OMNI_MODEL_ARTIFACTS;
const IMAGE = process.env.OMNI_MODEL_IMAGE ?? `ghcr.io/${REPO}:latest`;
/** Where release artifacts land — not the user's working tree. */
const ARTIFACT_DIR = ".omni-model";

export interface DeployOptions {
  answers: Answers;
  /** Environment variables holding the generated omni-model configuration. */
  configEnv: Record<string, string>;
  serviceName: string;
  /** Skip the confirmation prompt. */
  yes: boolean;
  /** Stage everything and print the command, but don't run it. */
  dryRun: boolean;
}

/** Run a command, streaming its output. Resolves with the exit code. */
function run(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit", shell: false });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(127));
  });
}

/** Decide whether to actually execute a command: never on a dry run. */
async function confirmRun(what: string, o: DeployOptions): Promise<boolean> {
  if (o.dryRun) {
    log.info(`[dry run] would run: ${what}`);
    return false;
  }
  if (o.yes) return true;
  const ok = await confirm({ message: `Run: ${what}` });
  return !isCancel(ok) && ok === true;
}

/** Remind the user which secrets the generated config still needs. */
function envReminder(a: Answers): void {
  const vars = envVarsFor(a);
  if (vars.length === 0) return;
  note(
    `${vars.map((v) => `  ${v}`).join("\n")}\n\nThe config references these; it holds no secret values itself.`,
    "Set these before the proxy will serve",
  );
}

/**
 * Cloudflare: the forkless path — download the prebuilt worker for a release
 * and deploy it. No fork, no clone, no build.
 */
async function deployCloudflare(o: DeployOptions): Promise<void> {
  const s = spinner();
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  if (LOCAL_ARTIFACTS !== undefined) {
    // Developing the CLI: use a locally built bundle instead of a release.
    s.start(`Using local artifacts from ${LOCAL_ARTIFACTS}`);
    try {
      for (const file of ["worker.js", "wrangler.jsonc"]) {
        cpSync(join(LOCAL_ARTIFACTS, file), join(ARTIFACT_DIR, file));
      }
    } catch (error) {
      s.stop("Local artifacts unusable");
      log.error(
        `OMNI_MODEL_ARTIFACTS=${LOCAL_ARTIFACTS} must hold worker.js + wrangler.jsonc (${String(error)})`,
      );
      return;
    }
    s.stop("Local artifacts staged");
  } else {
    s.start(`Downloading the prebuilt worker from ${REPO}`);
    const base = `https://github.com/${REPO}/releases/latest/download`;
    try {
      for (const file of ["worker.js", "wrangler.jsonc"]) {
        const res = await fetch(`${base}/${file}`);
        if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
        writeFileSync(join(ARTIFACT_DIR, file), Buffer.from(await res.arrayBuffer()));
      }
    } catch (error) {
      s.stop("Download failed");
      log.error(
        `Could not fetch the prebuilt worker (${String(error)}).\n` +
          `That release may not exist yet — see https://github.com/${REPO}/releases\n` +
          "To deploy a locally built bundle instead, set OMNI_MODEL_ARTIFACTS to a\n" +
          "directory holding worker.js + wrangler.jsonc.",
      );
      return;
    }
    s.stop("Prebuilt worker ready");
  }
  // Point the template at the user's chosen service name.
  const cfgPath = join(ARTIFACT_DIR, "wrangler.jsonc");
  writeFileSync(
    cfgPath,
    readFileSync(cfgPath, "utf8").replace(/"name":\s*"[^"]*"/, `"name": "${o.serviceName}"`),
  );

  envReminder(o.answers);
  const configArgs = Object.entries(o.configEnv).flatMap(([name, value]) => [
    "--var",
    `${name}:${value}`,
  ]);
  const args = ["wrangler", "deploy", "--config", cfgPath, ...configArgs];
  if (!(await confirmRun(`npx ${args.join(" ").slice(0, 60)}…`, o))) {
    log.info("Skipped. To deploy later:");
    log.message(
      `  npx wrangler deploy --config ${cfgPath} ${Object.keys(o.configEnv)
        .map((name) => `--var ${name}:<json>`)
        .join(" ")}`,
    );
    return;
  }
  const code = await run("npx", args);
  if (code !== 0) {
    log.error("wrangler exited non-zero — see its output above.");
    return;
  }
  for (const v of envVarsFor(o.answers)) {
    log.message(`  npx wrangler secret put ${v} --config ${cfgPath}`);
  }
}

/** Docker: run the published image locally, config via environment variables. */
async function deployDocker(o: DeployOptions): Promise<void> {
  envReminder(o.answers);
  const args = [
    "run",
    "--rm",
    "-p",
    "8787:8787",
    ...Object.entries(o.configEnv).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
    ...envVarsFor(o.answers).flatMap((v) => ["-e", v]), // forwarded from your shell
    IMAGE,
  ];
  if (!(await confirmRun(`docker run … ${IMAGE}`, o))) {
    log.info(
      `To run later:\n  docker run -p 8787:8787 ${Object.keys(o.configEnv)
        .map((name) => `-e ${name}=<json>`)
        .join(" ")} ${IMAGE}`,
    );
    return;
  }
  log.info("Starting on http://localhost:8787 — Ctrl-C to stop.");
  await run("docker", args);
}

/** Container platforms: generate the config and hand over the exact commands. */
function guideContainer(o: DeployOptions): void {
  envReminder(o.answers);
  const cloudRunEnv = Object.keys(o.configEnv)
    .map((name) => `  --set-env-vars '${name}=<json>'`)
    .join(" \\\n");
  const lines: Record<string, string[]> = {
    "cloud-run": [
      `gcloud run deploy ${o.serviceName} \\`,
      `  --image ${IMAGE} --port 8787 --allow-unauthenticated \\`,
      cloudRunEnv,
      "",
      "Firestore storage also needs the service account to have Firestore access:",
      "  gcloud projects add-iam-policy-binding $(gcloud config get-value project) \\",
      "    --member=serviceAccount:<runtime-sa> --role=roles/datastore.user",
    ],
    fly: [
      `fly launch --image ${IMAGE} --internal-port 8787`,
      `fly secrets set ${Object.keys(o.configEnv)
        .map((name) => `${name}=<json>`)
        .join(" ")}`,
    ],
    render: [
      "Render deploys from a Blueprint. Use the repo's render.yaml, or create a",
      `Web Service from the image ${IMAGE} and set the OMNI_*_JSON variables shown above.`,
    ],
  };
  note(
    (lines[o.answers.target] ?? []).join("\n"),
    `Run these to finish (${TARGETS[o.answers.target].label})`,
  );
  log.info(
    "Automated deploy for this target isn't wired up yet — these commands are the whole of it.",
  );
}

export async function deploy(o: DeployOptions): Promise<void> {
  switch (o.answers.target) {
    case "cloudflare":
      return deployCloudflare(o);
    case "docker":
      return deployDocker(o);
    default:
      return guideContainer(o);
  }
}
