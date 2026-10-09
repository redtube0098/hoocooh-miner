const fs = require("fs");
const path = require("path");
const JavaScriptObfuscator = require("javascript-obfuscator");

const apiSrcDir = path.join(__dirname, "../src/api");
const libSrcDir = path.join(__dirname, "../src/lib");
const apiDistDir = path.join(__dirname, "../api");
const libDistDir = path.join(__dirname, "../lib");

const obfuscatorOptions = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  numbersToExpressions: true,
  simplify: true,
  stringArray: true,
  stringArrayEncoding: ["base64"],
  stringArrayThreshold: 0.8,
  transformObjectKeys: true,
  identifierNamesGenerator: "hexadecimal",
  target: "node"
};

function obfuscateDirectory(srcDir, distDir, label) {
  console.log(`[Obfuscator] Processing ${label}...`);
  const files = fs.readdirSync(srcDir).filter(f => f.endsWith(".js"));

  for (const file of files) {
    const srcFile = path.join(srcDir, file);
    const distFile = path.join(distDir, file);

    const rawCode = fs.readFileSync(srcFile, "utf8");
    const t0 = Date.now();
    const result = JavaScriptObfuscator.obfuscate(rawCode, obfuscatorOptions);
    const obfCode = result.getObfuscatedCode();
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

    fs.writeFileSync(distFile, obfCode, "utf8");
    console.log(`  ✓ ${file}: ${rawCode.length} -> ${obfCode.length} bytes (${elapsed}s)`);
  }
}

console.log("[Obfuscator] Starting full backend obfuscation...");
obfuscateDirectory(libSrcDir, libDistDir, "lib/ modules");
obfuscateDirectory(apiSrcDir, apiDistDir, "api/ endpoints");
console.log("[Obfuscator] Backend obfuscation complete!");
