const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const profilePath = path.join(__dirname, '.bot-profile');

// 1. Automatically clean up the blocked profile from the previous attempt
if (fs.existsSync(profilePath)) {
  console.log('🧹 Clearing old flagged .bot-profile folder...');
  fs.rmSync(profilePath, { recursive: true, force: true });
}

// 2. Find your standard Windows Chrome installation
const chromePaths = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
];

const chromeExe = chromePaths.find(p => fs.existsSync(p));

if (!chromeExe) {
  console.error('❌ Could not find Google Chrome in standard Windows folders.');
  process.exit(1);
}

console.log('🚀 Opening native Google Chrome (100% undetected by Google Sign-In)...');
console.log('👉 Step 1: Log into your Google Flow Pro account in the window that opens.');
console.log('👉 Step 2: Once you see the Google Flow dashboard, CLOSE that Chrome window.');

// 3. Launch native Chrome pointing to .bot-profile (No Playwright flags attached)
const chromeProcess = spawn(chromeExe, [
  `--user-data-dir=${profilePath}`,
  '--no-first-run',
  '--no-default-browser-check',
  'https://labs.google/fx/tools/flow'
], { stdio: 'ignore' });

chromeProcess.on('close', () => {
  console.log('✅ Login session saved inside .bot-profile! Playwright can now use it silently.');
  process.exit(0);
});