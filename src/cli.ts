import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, join } from "node:path";
import type { App } from "./ir/index.js";
import { plan } from "./planner/index.js";
import { compileToCompose } from "./compilers/compose.js";
import { compileToDockerfile } from "./compilers/dockerfile.js";
import { compileToK8s } from "./compilers/k8s.js";

const II_DIR = ".ii";
const PLAN_FILE = "plan.json";

const USAGE = `Usage:
  ii plan                        <project-dir>   Analyze source, write .ii/${PLAN_FILE}
  ii deploy --local              <project-dir>   Deploy locally via Docker
  ii deploy --k8s                <project-dir>   Compile to k8s manifests
  ii deploy --local --plan FILE  <project-dir>   Deploy using an existing plan file
  ii deploy --k8s   --plan FILE  <project-dir>   Compile to k8s using an existing plan file`;

interface DeployOpts {
  target: string;
  planFile: string | null;
  projectDir: string;
}

function parseDeployArgs(args: string[]): DeployOpts {
  let target = "";
  let planFile: string | null = null;
  let projectDir = ".";

  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--local" || args[i] === "--k8s") {
      target = args[i];
    } else if (args[i] === "--plan") {
      planFile = args[++i];
    } else {
      positional.push(args[i]);
    }
  }

  if (positional.length > 0) projectDir = positional[0];

  return { target, planFile, projectDir: resolve(projectDir) };
}

function iiDir(projectDir: string): string {
  const dir = join(projectDir, II_DIR);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "plan") {
    const projectDir = resolve(args[1] ?? ".");
    doPlan(projectDir);
  } else if (command === "deploy") {
    const opts = parseDeployArgs(args.slice(1));

    if (opts.target === "--local") {
      doDeployLocal(opts);
    } else if (opts.target === "--k8s") {
      doDeployK8s(opts);
    } else {
      console.error(`Deploy requires --local or --k8s\n`);
      console.error(USAGE);
      process.exit(1);
    }
  } else {
    console.error(USAGE);
    process.exit(1);
  }
}

function doPlan(projectDir: string) {
  const app = plan(projectDir);
  const out = iiDir(projectDir);

  writeFileSync(join(out, PLAN_FILE), JSON.stringify(app, null, 2) + "\n");

  console.log(`${app.name}: ${app.services.length} service(s)\n`);
  for (const svc of app.services) {
    console.log(`  ${svc.name}`);
    console.log(`    port:    ${svc.port}`);
    console.log(`    ingress: ${svc.ingress ? "yes" : "no"}`);
  }
  console.log(`\nPlan written to ${II_DIR}/${PLAN_FILE}`);
}

function loadOrPlan(projectDir: string, planFile: string | null): App {
  if (planFile) {
    return JSON.parse(readFileSync(resolve(planFile), "utf-8")) as App;
  }

  const app = plan(projectDir);
  const out = iiDir(projectDir);
  writeFileSync(join(out, PLAN_FILE), JSON.stringify(app, null, 2) + "\n");
  return app;
}

function doDeployLocal({ projectDir, planFile }: DeployOpts) {
  const app = loadOrPlan(projectDir, planFile);
  const startCmd = getStartCmd(projectDir);
  const svc = app.services[0];
  const out = iiDir(projectDir);

  writeFileSync(join(out, "Dockerfile"), compileToDockerfile(svc, startCmd));
  writeFileSync(join(out, "docker-compose.yml"), compileToCompose(app));

  console.log(`${app.name}: deploying ${app.services.length} service(s) locally...\n`);

  execSync(`docker compose -f ${II_DIR}/docker-compose.yml up --build`, {
    cwd: projectDir,
    stdio: "inherit",
  });
}

function doDeployK8s({ projectDir, planFile }: DeployOpts) {
  const app = loadOrPlan(projectDir, planFile);
  const startCmd = getStartCmd(projectDir);
  const svc = app.services[0];
  const out = iiDir(projectDir);

  writeFileSync(join(out, "Dockerfile"), compileToDockerfile(svc, startCmd));
  writeFileSync(join(out, "k8s.yml"), compileToK8s(app));

  console.log(`${app.name}: compiled ${app.services.length} service(s)\n`);
  console.log(`  ${II_DIR}/Dockerfile`);
  console.log(`  ${II_DIR}/k8s.yml`);
}

function getStartCmd(projectDir: string): string {
  const pkg = JSON.parse(
    readFileSync(join(projectDir, "package.json"), "utf-8")
  ) as { scripts?: Record<string, string> };
  return pkg.scripts?.start ?? "node index.js";
}

main();
