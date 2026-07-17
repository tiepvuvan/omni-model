import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const IMAGE = `ghcr.io/${REPO}:latest`;
/** Where downloaded release artifacts land — not the user's working tree. */
const ARTIFACT_DIR = ".omni-model";

export interface DeployOptions {
  answers: Answers;
  configPath: string;
  serviceName: string;
  /** Skip the confirmation prompt. */
  yes: boolean;
}

/** Run a command, streaming its output. Resolves with the exit code. */
function run(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit", shell: false });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(127));
  });
}

async function confirmRun(what: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
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
  s.start(`Downloading the prebuilt worker from ${REPO}`);
  mkdirSync(ARTIFACT_DIR, { recursive: true });
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
        `Releases: https://github.com/${REPO}/releases`,
    );
    return;
  }
  // Point the template at the user's chosen service name.
  const cfgPath = join(ARTIFACT_DIR, "wrangler.jsonc");
  writeFileSync(
    cfgPath,
    readFileSync(cfgPath, "utf8").replace(/"name":\s*"[^"]*"/, `"name": "${o.serviceName}"`),
  );
  s.stop("Prebuilt worker ready");

  envReminder(o.answers);
  const omniConfig = readFileSync(o.configPath, "utf8");
  const args = ["wrangler", "deploy", "--config", cfgPath, "--var", `OMNI_CONFIG:${omniConfig}`];
  if (!(await confirmRun(`npx ${args.join(" ").slice(0, 60)}…`, o.yes))) {
    log.info("Skipped. To deploy later:");
    log.message(
      `  npx wrangler deploy --config ${cfgPath} --var OMNI_CONFIG:"$(cat ${o.configPath})"`,
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

/** Docker: run the published image locally, config via OMNI_CONFIG. */
async function deployDocker(o: DeployOptions): Promise<void> {
  envReminder(o.answers);
  const omniConfig = readFileSync(o.configPath, "utf8");
  const args = [
    "run",
    "--rm",
    "-p",
    "8787:8787",
    "-e",
    `OMNI_CONFIG=${omniConfig}`,
    ...envVarsFor(o.answers).flatMap((v) => ["-e", v]), // forwarded from your shell
    IMAGE,
  ];
  if (!(await confirmRun(`docker run … ${IMAGE}`, o.yes))) {
    log.info(
      `To run later:\n  docker run -p 8787:8787 -e OMNI_CONFIG="$(cat ${o.configPath})" ${IMAGE}`,
    );
    return;
  }
  log.info("Starting on http://localhost:8787 — Ctrl-C to stop.");
  await run("docker", args);
}

/** Container platforms: generate the config and hand over the exact commands. */
function guideContainer(o: DeployOptions): void {
  envReminder(o.answers);
  const c = o.configPath;
  const lines: Record<string, string[]> = {
    "cloud-run": [
      `gcloud run deploy ${o.serviceName} \\`,
      `  --image ${IMAGE} --port 8787 --allow-unauthenticated \\`,
      `  --set-env-vars OMNI_CONFIG="$(cat ${c})"`,
      "",
      "Firestore storage also needs the service account to have Firestore access:",
      "  gcloud projects add-iam-policy-binding $(gcloud config get-value project) \\",
      "    --member=serviceAccount:<runtime-sa> --role=roles/datastore.user",
    ],
    fly: [
      `fly launch --image ${IMAGE} --internal-port 8787`,
      `fly secrets set OMNI_CONFIG="$(cat ${c})"`,
    ],
    render: [
      "Render deploys from a Blueprint. Use the repo's render.yaml, or create a",
      `Web Service from the image ${IMAGE} and set OMNI_CONFIG to the contents of ${c}.`,
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
