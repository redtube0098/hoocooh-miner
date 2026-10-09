const fs = require("fs");
const path = require("path");
const JavaScriptObfuscator = require("javascript-obfuscator");

const srcPath = path.join(__dirname, "../src/index.src.html");
const distPath = path.join(__dirname, "../public/index.html");

console.log("[Build] Reading master source from src/index.src.html...");
if (!fs.existsSync(srcPath)) {
  console.error("[Build Error] Source file src/index.src.html not found!");
  process.exit(1);
}

const html = fs.readFileSync(srcPath, "utf8");

// Match the main inline application script (the last script containing (function(){...})())
const scriptRegex = /<script>([\s\S]*?\(function\(\)\{[\s\S]*?\}\)\(\);[\s\S]*?)<\/script>/i;
const match = html.match(scriptRegex);

if (!match) {
  console.error("[Build Error] Could not locate main application script block in source HTML!");
  process.exit(1);
}

const rawJs = match[1];
console.log(`[Build] Found application script (${rawJs.length} characters). Obfuscating...`);

const startTime = Date.now();
const obfuscationResult = JavaScriptObfuscator.obfuscate(rawJs, {
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
  target: "browser"
});

const obfuscatedJs = obfuscationResult.getObfuscatedCode();
const duration = ((Date.now() - startTime) / 1000).toFixed(2);
console.log(`[Build] Obfuscation complete in ${duration}s. Obfuscated size: ${obfuscatedJs.length} characters.`);

// Replace script in HTML safely without string.replace $ patterns
const newHtml = html.replace(scriptRegex, () => `<script>\n${obfuscatedJs}\n</script>`);

fs.writeFileSync(distPath, newHtml, "utf8");
console.log("[Build] Successfully wrote obfuscated production app to public/index.html!");
