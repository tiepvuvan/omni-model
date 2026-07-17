#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { cancel, confirm, intro, isCancel, log, outro, text } from "@clack/prompts";
import { Command } from "commander";
import { toYaml } from "./config.js";
import { deploy } from "./deploy.js";
import { runWizard } from "./wizard.js";

/**
 * `omni-model` — deploy a self-hosted, OpenAI-compatible AI proxy.
 *
 *   npx omni-model deploy    interactive: pick a target, storage and limits,
 *                            write omni.yaml, then deploy it
 *   npx omni-model init      write omni.yaml and stop
 *
 * The CLI never holds your API keys: it emits `${ENV}` references and points you
 * at the platform command that sets them.
 */

const VERSION = "0.1.0";

async function writeConfig(path: string, yaml: string, yes: boolean): Promise<boolean> {
  if (existsSync(path) && !yes) {
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

async function askServiceName(defaultName: string, yes: boolean): Promise<string> {
  if (yes) return defaultName;
  const name = await text({
    message: "Service name",
    initialValue: defaultName,
    validate: (v) =>
      v && /^[a-z0-9][a-z0-9-]*$/.test(v) ? undefined : "Lowercase letters, digits and -",
  });
  if (isCancel(name)) {
    cancel("Cancelled.");
    process.exit(0);
  }
  return name;
}

const program = new Command();

program
  .name("omni-model")
  .description("Deploy a self-hosted, OpenAI-compatible AI proxy.")
  .version(VERSION);

program
  .command("deploy", { isDefault: true })
  .description("Interactively configure and deploy the proxy")
  .option("-c, --config <path>", "config file to write", "omni.yaml")
  .option("-y, --yes", "skip confirmations (uses defaults)", false)
  .option("--dry-run", "show what would happen without deploying", false)
  .action(async (opts: { config: string; yes: boolean; dryRun: boolean }) => {
    intro("omni-model — deploy an AI proxy you own");
    const answers = await runWizard();
    const yaml = toYaml(answers);
    await writeConfig(opts.config, yaml, opts.yes);
    const serviceName = await askServiceName("omni-model", opts.yes);
    await deploy({
      answers,
      configPath: opts.config,
      serviceName,
      yes: opts.yes,
      dryRun: opts.dryRun,
    });
    outro("Done. Edit omni.yaml and re-run to change anything.");
  });

program
  .command("init")
  .description("Write an omni.yaml without deploying")
  .option("-c, --config <path>", "config file to write", "omni.yaml")
  .option("-y, --yes", "skip confirmations", false)
  .action(async (opts: { config: string; yes: boolean }) => {
    intro("omni-model — configure");
    const answers = await runWizard();
    await writeConfig(opts.config, toYaml(answers), opts.yes);
    outro(`Run \`omni-model deploy\` when you're ready to ship ${opts.config}.`);
  });

await program.parseAsync();
