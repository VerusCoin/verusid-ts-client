const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const manifestPath = path.join(projectRoot, "package.json");
const dependencies = [
  {
    name: "verus-typescript-primitives",
    repository: "https://github.com/VerusCoin/verus-typescript-primitives.git",
    ref: "HEAD"
  },
  {
    name: "verusd-rpc-ts-client",
    repository: "https://github.com/VerusCoin/verusd-rpc-ts-client",
    ref: "HEAD"
  },
  {
    name: "@bitgo/utxo-lib",
    repository: "https://github.com/VerusCoin/BitGoJS.git",
    ref: "refs/heads/utxo-lib-verus"
  }
];

function resolveRevision(dependency) {
  let output;
  try {
    output = execFileSync("git", ["ls-remote", "--exit-code", dependency.repository, dependency.ref], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    const detail = error.stderr ? String(error.stderr).trim() : error.message;
    throw new Error(`Could not resolve ${dependency.name} (${dependency.ref}): ${detail}`);
  }

  const records = output.trim().split(/\r?\n/).map(line => line.trim().split(/\s+/));
  if (records.length !== 1 || records[0].length !== 2 ||
      records[0][1] !== dependency.ref || !/^[0-9a-f]{40}$/i.test(records[0][0])) {
    throw new Error(`Expected one valid Git revision for ${dependency.name} (${dependency.ref}); package.json was not changed.`);
  }

  return `git+${dependency.repository}#${records[0][0].toLowerCase()}`;
}

try {
  // Resolve every repository before changing any dependency or resolution.
  const pins = dependencies.map(dependency => [dependency.name, resolveRevision(dependency)]);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  for (const [name, pin] of pins) manifest.dependencies[name] = pin;
  manifest.resolutions = manifest.resolutions || {};
  manifest.resolutions["verus-typescript-primitives"] = manifest.dependencies["verus-typescript-primitives"];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  for (const [name, pin] of pins) console.log(`${name}: ${pin}`);

  // Reuse the Yarn CLI that launched this script, including Corepack-managed Yarn.
  // Inherit the environment so configured caches and registry settings still apply.
  const yarnPath = process.env.npm_execpath;
  const launchedByYarn = /^yarn\//.test(process.env.npm_config_user_agent || "");
  const command = launchedByYarn && yarnPath ? process.execPath : "yarn";
  const args = launchedByYarn && yarnPath ? [yarnPath, "install"] : ["install"];

  try {
    execFileSync(command, args, { cwd: projectRoot, stdio: "inherit" });
  } catch (error) {
    const detail = error.signal ? `signal ${error.signal}` : error.status != null ? `exit ${error.status}` : error.message;
    throw new Error(`Yarn install failed (${detail}). The new pins remain in package.json; resolve the installation error and run yarn install again.`);
  }
} catch (error) {
  console.error(`Unable to update Verus libraries: ${error.message}`);
  process.exitCode = 1;
}
