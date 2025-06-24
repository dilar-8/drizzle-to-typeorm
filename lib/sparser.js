const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

/**
 * Sparse-checkout and flatten specific subfolder from a Git repo into a clean output directory.
 *
 * @param {string} repoUrl - SSH or HTTPS Git repo URL
 * @param {string} repoSubfolder - Subfolder inside the repo to pull
 * @param {string} outputDir - Directory to place flattened files
 */
function sparseFetch(repoUrl, repoSubfolder, outputDir) {
  const absoluteOutput = path.resolve(outputDir);

  if (fs.existsSync(absoluteOutput)) {
    if (process.cwd().startsWith(absoluteOutput)) {
      process.chdir(path.dirname(absoluteOutput));
    }
    fs.rmSync(absoluteOutput, { recursive: true });
  }

  execSync(
    `git clone --no-checkout --filter=blob:none ${repoUrl} ${absoluteOutput}`
  );
  process.chdir(absoluteOutput);

  execSync(`git sparse-checkout init --no-cone`);
  execSync(`git sparse-checkout set ${repoSubfolder}`);
  execSync(`git checkout`);

  const subfolderPath = path.join(process.cwd(), repoSubfolder);
  if (!fs.existsSync(subfolderPath)) {
    throw new Error(`❌ Repo subfolder not found: ${repoSubfolder}`);
  }

  const files = fs.readdirSync(subfolderPath);

  for (const file of files) {
    const source = path.join(subfolderPath, file);
    const destination = path.join(process.cwd(), file);
    if (fs.lstatSync(source).isFile()) {
      fs.renameSync(source, destination);
    }
  }

  const topLevelDir = repoSubfolder.split("/")[0];
  const cleanupPath = path.join(process.cwd(), topLevelDir);

  if (fs.existsSync(cleanupPath)) {
    fs.rmSync(cleanupPath, { recursive: true });
  }
}

module.exports = { sparseFetch };
