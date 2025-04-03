const fs = require('fs');
const path = require('path');

// Simple script to prepare files for Netlify deployment without complex webpack transpilation

// Ensure directories exist
const functionsDir = path.join(__dirname, 'functions-build');
if (!fs.existsSync(functionsDir)) {
  fs.mkdirSync(functionsDir);
}

// Copy the simple webhook function
const sourceFile = path.join(__dirname, 'functions', 'webhook-simple.js');
const targetFile = path.join(functionsDir, 'webhook-simple.js');

fs.copyFileSync(sourceFile, targetFile);
console.log(`✅ Copied webhook-simple.js to functions-build directory`);

console.log('✅ Deploy preparation completed');
