const fs = require("fs");
const path = require("path");

const vendorDir = path.join(__dirname, "..", "static", "vendor");
fs.mkdirSync(vendorDir, { recursive: true });

const files = [
  ["node_modules/alpinejs/dist/cdn.min.js", "static/vendor/alpine.min.js"],
];

for (const [src, dest] of files) {
  const srcPath = path.join(__dirname, "..", src);
  const destPath = path.join(__dirname, "..", dest);
  fs.copyFileSync(srcPath, destPath);
  console.log(`Copied ${src} -> ${dest}`);
}

fs.cpSync(
  path.join(__dirname, "..", "node_modules", "@videojs", "cdn"),
  path.join(vendorDir, "videojs"),
  { recursive: true },
);
console.log("Copied @videojs/cdn -> static/vendor/videojs");
