const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect x="32" y="32" width="960" height="960" rx="220" fill="#0f172a"/>
  <path d="M176 288 V736 H288 V480 L512 736 L736 480 V736 H848 V288 H736 L512 544 L288 288 Z" fill="#f8fafc"/>
  <path d="M512 772 V920" stroke="#f8fafc" stroke-width="72" stroke-linecap="round"/>
  <path d="M420 852 L512 944 L604 852" fill="none" stroke="#f8fafc" stroke-width="72" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });

sharp(Buffer.from(svg))
  .png()
  .toFile(path.join(outDir, 'icon.png'))
  .then(() => {
    console.log('icon generated: build/icon.png');
  })
  .catch((err) => {
    console.error('icon generation failed:', err);
    process.exit(1);
  });
