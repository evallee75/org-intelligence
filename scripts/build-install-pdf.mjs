#!/usr/bin/env node
// Génère docs/Org-Intelligence-Installation.pdf à partir de docs/INSTALL.md.
// Prérequis : pandoc et Google Chrome (ou Chromium) installés.
// Usage : node scripts/build-install-pdf.mjs   (après toute modification de docs/INSTALL.md)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  ".."
);
const source = path.join(root, "docs/INSTALL.md");
const output = path.join(root, "docs/Org-Intelligence-Installation.pdf");
const css = fs.readFileSync(
  path.join(root, "docs/assets/install-pdf.css"),
  "utf8"
);

const chrome = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium"
].find((candidate) => candidate && fs.existsSync(candidate));
if (!chrome) {
  console.error("Google Chrome not found (set CHROME_PATH).");
  process.exit(1);
}

// Markdown → HTML (pandoc), liens internes du dépôt rendus absolus vers GitHub
const repo = "https://github.com/evallee75/org-intelligence/blob/main/docs/";
let body = execFileSync(
  "pandoc",
  ["--from", "gfm", "--to", "html5", "--syntax-highlighting=none", source],
  {
    encoding: "utf8"
  }
);
body = body.replace(
  /href="(?!https?:|#)([^"]+)"/g,
  (_, link) => `href="${repo}${link}"`
);

const date = new Date().toISOString().slice(0, 10);
const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>Org Intelligence — Installation</title><style>${css}</style></head><body>
<div class="cover"><div class="kicker">Guide d'installation</div>
<div class="name">Org Intelligence</div>
<div class="sub">Scanner open source de santé d'une org Salesforce — sandbox et production</div></div>
${body}
<div class="footer-note">github.com/evallee75/org-intelligence · licence MIT · version du ${date}</div>
</body></html>`;

const work = fs.mkdtempSync(path.join(os.tmpdir(), "oi-pdf-"));
const htmlFile = path.join(work, "install.html");
fs.writeFileSync(htmlFile, html);
execFileSync(
  chrome,
  [
    "--headless",
    "--disable-gpu",
    "--no-pdf-header-footer",
    `--print-to-pdf=${output}`,
    `file://${htmlFile}`
  ],
  { stdio: "ignore" }
);
fs.rmSync(work, { recursive: true, force: true });
console.log(`✔ ${path.relative(root, output)}`);
