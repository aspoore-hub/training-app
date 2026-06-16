const fs = require("fs");
const path = require("path");

const root = process.cwd();
const distDir = path.join(root, "dist");
const publicDir = path.join(root, "public");
const indexPath = path.join(distDir, "index.html");

function copyPublicFiles() {
  if (!fs.existsSync(publicDir)) return;
  fs.cpSync(publicDir, distDir, { recursive: true });
}

function ensureHeadTags() {
  if (!fs.existsSync(indexPath)) {
    throw new Error("dist/index.html was not found after web export.");
  }

  let html = fs.readFileSync(indexPath, "utf8");
  const tags = [
    '<meta name="application-name" content="Training App" />',
    '<meta name="apple-mobile-web-app-capable" content="yes" />',
    '<meta name="apple-mobile-web-app-title" content="Training App" />',
    '<meta name="apple-mobile-web-app-status-bar-style" content="default" />',
    '<meta name="mobile-web-app-capable" content="yes" />',
    '<meta name="theme-color" content="#0f172a" />',
    '<link rel="manifest" href="/manifest.json" />',
    '<link rel="apple-touch-icon" href="/icon-192.png" />',
  ];

  const missingTags = tags.filter((tag) => !html.includes(tag));
  if (missingTags.length === 0) return;

  html = html.replace("</head>", `  ${missingTags.join("\n  ")}\n</head>`);
  fs.writeFileSync(indexPath, html);
}

copyPublicFiles();
ensureHeadTags();
