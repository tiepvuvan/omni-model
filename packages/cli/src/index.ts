#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { cancel, confirm, intro, isCancel, log, outro, text } from "@clack/prompts";
import { Command, Option } from "commander";
import { type Answers, toYaml } from "./config.js";
import { deploy } from "./deploy.js";
import { answersFromFlags, type DeployFlags, FlagError, hasFlags } from "./flags.js";
import { runWizard } from "./wizard.js";

/**
 * `omni-model` — deploy a self-hosted, OpenAI-compatible AI proxy.
 *
 *   npx omni-model deploy    interactive: pick a target, storage and limits,
 *                            write omni.yaml, then deploy it
 *   npx omni-model init      write omni.yaml and stop
 *
 * Both work non-interactively too: pass `--target` (plus `--auth`) and the
 * wizard is skipped entirely, so this is usable from CI and scripts.
 *
 * The CLI never holds your API keys: it emits `${ENV}` references and points you
 * at the platform command that sets them.
 */

const VERSION = "0.1.0";

/** Prompting is only possible on a real terminal. */
function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/**
 * Flags win; otherwise prompt. Without a TTY we must not prompt — clack would
 * hang a CI job forever — so say what's missing instead.
 */
async function resolveAnswers(flags: DeployFlags): Promise<Answers> {
  if (hasFlags(flags)) return answersFromFlags(flags);
  if (!isInteractive()) {
    throw new FlagError(
      "no terminal to prompt on (stdin isn't a TTY). Pass flags instead, e.g.\n" +
        "  omni-model deploy --target cloudflare --auth firebase-app-check --yes\n" +
        "Run `omni-model deploy --help` for every flag.",
    );
  }
  return runWizard();
}

async function writeConfig(path: string, yaml: string, yes: boolean): Promise<boolean> {
  if (existsSync(path) && !yes) {
    if (!isInteractive()) {
      throw new FlagError(`${path} already exists — pass --yes to overwrite it.`);
    }
    const overwrite = await confirm({
      message: `${path} exists — overwrite?`,
      initialValue: false,
    });
    if (isCancel(overwrite) || !overwrite) {
      log.info(`Kept your existing ${path}.`);
      return false;
    }
  }
  writeFileSync(path, yaml);
  log.success(`Wrote ${path}`);
  return true;
}

async function askServiceName(flagName: string | undefined, yes: boolean): Promise<string> {
  if (flagName !== undefined) return flagName;
  if (yes || !isInteractive()) return "omni-model";
  const name = await text({
    message: "Service name",
    initialValue: "omni-model",
    validate: (v) =>
      v && /^[a-z0-9][a-z0-9-]*$/.test(v) ? undefined : "Lowercase letters, digits and -",
  });
  if (isCancel(name)) {
    cancel("Cancelled.");
    process.exit(0);
  }
  return name;
}

/** Answer flags, shared by `deploy` and `init`. */
function withAnswerFlags(cmd: Command): Command {
  return cmd
    .addOption(
      new Option("-t, --target <target>", "where to deploy (skips the wizard)").choices([
        "cloudflare",
        "cloud-run",
        "fly",
        "render",
        "docker",
      ]),
    )
    .option("-s, --storage <storage>", "rate-limit storage (default: best for the target)")
    .option(
      "--provider <provider>",
      "upstream: openai|anthropic|google|openai-compatible",
      "openai",
    )
    .option("--provider-name <name>", "name for the provider in routing")
    .option("--base-url <url>", "base URL (required for openai-compatible)")
    .option("--api-key-env <VAR>", "env var holding the provider API key")
    .option("--auth <list>", 'comma-separated verifiers, or "none" for an open proxy')
    .option("--firebase-project-id <id>")
    .option("--firebase-project-number <number>")
    .option("--apple-team-id <id>")
    .option("--apple-bundle-id <id>")
    .option("--requests-per-minute <n>", "per-caller request limit (0 = none)")
    .option("--tokens-per-day <n>", "per-caller token budget (0 = none)")
    .option("-c, --config <path>", "config file to write", "omni.yaml")
    .option("-y, --yes", "skip confirmations", false);
}

const program = new Command();

program
  .name("omni-model")
  .description("Deploy a self-hosted, OpenAI-compatible AI proxy.")
  .version(VERSION);

withAnswerFlags(program.command("deploy", { isDefault: true }))
  .description("Configure and deploy the proxy (interactive, or pass --target)")
  .option("--name <name>", "service/worker name")
  .option("--dry-run", "show what would happen without deploying", false)
  .action(async (opts: DeployFlags & Record<string, string | boolean | undefined>) => {
    intro("omni-model — deploy an AI proxy you own");
    const answers = await resolveAnswers(opts);
    await writeConfig(opts.config as string, toYaml(answers), opts.yes === true);
    const serviceName = await askServiceName(opts.name as string | undefined, opts.yes === true);
    await deploy({
      answers,
      configPath: opts.config as string,
      serviceName,
      yes: opts.yes === true,
      dryRun: opts.dryRun === true,
    });
    outro("Done. Edit omni.yaml and re-run to change anything.");
  });

withAnswerFlags(program.command("init"))
  .description("Write an omni.yaml without deploying")
  .action(async (opts: DeployFlags & Record<string, string | boolean | undefined>) => {
    intro("omni-model — configure");
    const answers = await resolveAnswers(opts);
    await writeConfig(opts.config as string, toYaml(answers), opts.yes === true);
    outro(`Run \`omni-model deploy\` when you're ready to ship ${opts.config}.`);
  });

try {
  await program.parseAsync();
} catch (error) {
  // A flag mistake is the user's, not a crash: print it, don't dump a stack.
  if (error instanceof FlagError) {
    log.error(error.message);
    process.exit(2);
  }
  throw error;
}
