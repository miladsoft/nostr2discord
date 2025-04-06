const fs = require('fs');
const path = require('path');

// Ensure directories exist
const functionsDir = path.join(__dirname, 'functions-build');
if (!fs.existsSync(functionsDir)) {
  fs.mkdirSync(functionsDir);
}

// Copy the functions
const functionFiles = ['webhook.js', 'webhook-simple.js'];

functionFiles.forEach(file => {
  const sourceFile = path.join(__dirname, 'functions', file);
  const targetFile = path.join(functionsDir, file);
  
  if (fs.existsSync(sourceFile)) {
    fs.copyFileSync(sourceFile, targetFile);
    console.log(`✅ Copied ${file} to functions-build directory`);
  } else {
    console.warn(`⚠️ Source file ${file} not found in functions directory`);
  }
});

// Create a test file for the webhook
const testFilePath = path.join(__dirname, 'public', 'test.html');
const testFileContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Test Nostr2Discord</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
    .card { background: #f5f5f5; padding: 15px; border-radius: 5px; margin-bottom: 15px; }
    button { padding: 8px 16px; background: #4a69bd; color: white; border: none; border-radius: 4px; cursor: pointer; }
    pre { background: #eee; padding: 10px; border-radius: 4px; overflow: auto; }
    .success { color: green; }
    .error { color: red; }
  </style>
</head>
<body>
  <h1>Test Nostr2Discord Webhook</h1>
  
  <div class="card">
    <h2>Check Status</h2>
    <button onclick="checkStatus()">Check Status</button>
    <pre id="status-result"></pre>
  </div>
  
  <div class="card">
    <h2>Test Nostr Event</h2>
    <button onclick="testNostrEvent()">Send Test Event</button>
    <pre id="test-result"></pre>
  </div>
  
  <script>
    const API_URL = '/api/webhook-simple';
    
    async function checkStatus() {
      const resultElement = document.getElementById('status-result');
      resultElement.innerHTML = 'Loading...';
      
      try {
        const response = await fetch(API_URL);
        const data = await response.json();
        
        resultElement.innerHTML = JSON.stringify(data, null, 2);
        resultElement.className = 'success';
      } catch (error) {
        resultElement.innerHTML = 'Error: ' + error.message;
        resultElement.className = 'error';
      }
    }
    
    async function testNostrEvent() {
      const resultElement = document.getElementById('test-result');
      resultElement.innerHTML = 'Loading...';
      
      // Create a test event
      const testEvent = {
        id: "5c83da77af1dec069c6b1ee166539582b875c3f85215fdd3f3be889322013014",
        pubkey: "97c70a44366a6535c145b333f973ea86dfdc2d7a99da618c40c64705ad98e322",
        created_at: Math.floor(Date.now() / 1000),
        kind: 1,
        tags: [],
        content: "This is a test post from Nostr2Discord test page 🧪",
        sig: "78ee9bae33a3f3b0aae9e133521af43a337eecd8a88edba3f821a3ef9751ea3061a75827f0f7428155ba20fe524d93e1b1369b6c094c9caa93311e45e42ee967"
      };
      
      try {
        const response = await fetch(API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(testEvent)
        });
        
        const data = await response.json();
        
        resultElement.innerHTML = JSON.stringify(data, null, 2);
        resultElement.className = response.ok ? 'success' : 'error';
      } catch (error) {
        resultElement.innerHTML = 'Error: ' + error.message;
        resultElement.className = 'error';
      }
    }
    
    // Auto-check status on page load
    window.addEventListener('DOMContentLoaded', () => {
      setTimeout(checkStatus, 500);
    });
  </script>
</body>
</html>
`;

// Create the public directory if it doesn't exist
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir);
}

fs.writeFileSync(testFilePath, testFileContent);
console.log('✅ Created test.html in public directory');

console.log('✅ Deploy preparation completed');
