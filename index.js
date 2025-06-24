const fs = require("fs");
const path = require("path");
const { sparseFetch } = require("./sparser");
const { convertSchemas } = require("./converter");

/**
 * Fetches .ts schema files from a Git repo and converts them to .js
 */
async function fetchAndConvertSchemas(repoUrl, repoSubfolder, outputDir) {
  const outputPath = path.resolve(outputDir);

  sparseFetch(repoUrl, repoSubfolder, outputPath);

  const tsFiles = fs.readdirSync(outputPath).filter((f) => f.endsWith(".ts"));
  const files = tsFiles.map((f) => ({
    fileName: path.join(outputPath, f),
    content: fs.readFileSync(path.join(outputPath, f), "utf8"),
  }));

  if (files.length === 0) return;

  const result = convertSchemas(files);

  for (const [file, content] of Object.entries(result)) {
    fs.writeFileSync(file, content, "utf8");
  }

  for (const { fileName } of files) {
    fs.unlinkSync(fileName);
  }

  console.log(`Converted ${files.length} file(s) from Git 🚀`);
}

/**
 * Converts local .ts schema files from one folder to .js in another folder
 */
async function convertLocalSchemas(inputDir, outputDir) {
  const inputPath = path.resolve(inputDir);
  const outputPath = path.resolve(outputDir);

  if (!fs.existsSync(outputPath)) {
    fs.mkdirSync(outputPath, { recursive: true });
  }

  const tsFiles = fs.readdirSync(inputPath).filter((f) => f.endsWith(".ts"));
  const files = tsFiles.map((f) => ({
    fileName: path.join(inputPath, f),
    content: fs.readFileSync(path.join(inputPath, f), "utf8"),
  }));

  if (files.length === 0) return;

  const result = convertSchemas(files);

  for (const [file, content] of Object.entries(result)) {
    const outName = path.join(outputPath, path.basename(file));
    fs.writeFileSync(outName, content, "utf8");
  }

  console.log(`Converted ${files.length} local file(s) 🚀`);
}

module.exports = {
  fetchAndConvertSchemas,
  convertLocalSchemas,
};
