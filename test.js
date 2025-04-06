require('dotenv').config();
require('websocket-polyfill');
const { nip19, relayInit } = require('nostr-tools');
const { sendToDiscord } = require('./index');
const fetch = require('node-fetch');

const DEFAULT_RELAYS = [
  'wss://relay.nostr.band',
  'wss://relay.damus.io',
  'wss://eden.nostr.land',
  'wss://nos.lol',
  'wss://relay.snort.social',
  'wss://relay.current.fyi',
  'wss://brb.io',
  'wss://nostr.orangepill.dev',
  'wss://nostr-pub.wellorder.net',
  'wss://nostr.wine',
  'wss://nostr.bitcoiner.social',
  'wss://relay.primal.net'
].join(',');

// Helper function to test a single relay connection
async function testRelay(url) {
  return new Promise((resolve) => {
    try {
      const relay = relayInit(url);
      let resolved = false;
      let connectionTimeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve({ url, status: 'timeout', message: 'Connection timed out after 5s' });
        }
      }, 5000);

      relay.on('connect', () => {
        if (!resolved) {
          clearTimeout(connectionTimeout);
          resolved = true;
          resolve({ url, status: 'success', message: 'Connected successfully' });
        }
      });

      relay.on('error', () => {
        if (!resolved) {
          clearTimeout(connectionTimeout);
          resolved = true;
          resolve({ url, status: 'error', message: 'Connection error' });
        }
      });

      relay.connect();
    } catch (error) {
      resolve({ url, status: 'error', message: error ? (error.message || error.toString()) : 'Unknown error' });
    }
  });
}

async function runTests() {
  console.log("=== NOSTR2DISCORD TEST UTILITY ===");

  // Check environment variables
  const pubkey = process.env.NOSTR_PUBKEY;
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  const relays = process.env.NOSTR_RELAYS || DEFAULT_RELAYS;

  console.log("Environment check:");
  console.log(`- NOSTR_PUBKEY: ${pubkey ? '✅ Set' : '❌ Not set'}`);
  console.log(`- DISCORD_WEBHOOK_URL: ${webhookUrl ? '✅ Set' : '❌ Not set'}`);
  console.log(`- NOSTR_RELAYS: ${relays ? '✅ Set' : '❌ Not set'}`);

  // If pubkey is in npub format, try to decode it
  if (pubkey && pubkey.startsWith('npub')) {
    try {
      const decoded = nip19.decode(pubkey);
      console.log(`\nDecoded npub to hex: ${decoded.data}`);
      console.log(`You should update your .env file to use the hex format.`);
    } catch (error) {
      console.error(`\nFailed to decode npub: ${error ? (error.message || error.toString()) : 'Unknown error'}`);
    }
  }

  // Test relay connections if relays are configured
  if (relays) {
    const relayUrls = relays.split(',');
    console.log("\n=== Testing Relay Connections ===");
    
    const results = await Promise.all(relayUrls.map(url => testRelay(url)));
    
    console.log("\nRelay connection results:");
    results.forEach(result => {
      const statusIcon = result.status === 'success' ? '✅' : '❌';
      console.log(`${statusIcon} ${result.url}: ${result.message}`);
    });
    
    const successfulRelays = results.filter(r => r.status === 'success').length;
    console.log(`\nSummary: ${successfulRelays}/${results.length} relays connected successfully`);
    
    if (successfulRelays === 0) {
      console.log("\n⚠️  WARNING: No relays could be connected. Check your network or relay URLs.");
    }
  }

  // Test sending to Discord with a mock event
  if (webhookUrl) {
    console.log("\n=== Testing Discord Webhook ===");
    
    const mockEvent = {
      id: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      pubkey: pubkey || "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      created_at: Math.floor(Date.now() / 1000),
      kind: 1,
      tags: [],
      content: "This is a test event from the Nostr2Discord test utility. If you see this message in Discord, the webhook is working correctly!",
      sig: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    };

    try {
      console.log("Sending test event to Discord...");
      await sendToDiscord(mockEvent);
      console.log("✅ Test message sent to Discord! Check your Discord channel.");
    } catch (error) {
      console.error(`❌ Failed to send test message: ${error ? (error.message || error.toString()) : 'Unknown error'}`);
    }
  }

  console.log("\nTest complete!");
}

// Test function to generate a sample Nostr event
function createSampleEvent() {
  // Note: This is a test event without a valid signature
  // In production, you would properly sign the event
  return {
    id: "5c83da77af1dec069c6b1ee166539582b875c3f85215fdd3f3be889322013014",
    pubkey: "97c70a44366a6535c145b333f973ea86dfdc2d7a99da618c40c64705ad98e322",
    created_at: Math.floor(Date.now() / 1000),
    kind: 1,
    tags: [],
    content: "This is a test Nostr post from the test script 🧪",
    sig: "78ee9bae33a3f3b0aae9e133521af43a337eecd8a88edba3f821a3ef9751ea3061a75827f0f7428155ba20fe524d93e1b1369b6c094c9caa93311e45e42ee967"
  };
}

// Function to test the configuration update
async function testConfigUpdate() {
  console.log('\n=== Testing Configuration Update ===');
  
  const payload = {
    nostrPubkey: process.env.NOSTR_PUBKEY || 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3vfkdq',
    discordWebhook: process.env.DISCORD_WEBHOOK_URL || 'https://discord.com/api/webhooks/example',
    relays: 'wss://relay.damus.io,wss://relay.nostr.band',
    preferredClient: 'all'
  };
  
  try {
    console.log(`Sending config update: ${JSON.stringify(payload)}`);
    
    const response = await fetch('http://localhost:8888/api/webhook-simple', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    const data = await response.json();
    console.log('Response:', data);
    
    if (response.ok) {
      console.log('✅ Configuration update test passed!');
    } else {
      console.log('❌ Configuration update test failed!');
    }
  } catch (error) {
    console.error('Error during test:', error);
    console.log('❌ Configuration update test failed!');
  }
}

// Function to test sending a Nostr event
async function testNostrEvent() {
  console.log('\n=== Testing Nostr Event Processing ===');
  
  const event = createSampleEvent();
  
  try {
    console.log(`Sending test event with ID: ${event.id}`);
    
    const response = await fetch('http://localhost:8888/api/webhook-simple', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    });
    
    const data = await response.json();
    console.log('Response:', data);
    
    if (response.ok) {
      console.log('✅ Event processing test passed!');
    } else {
      console.log('❌ Event processing test failed!');
    }
  } catch (error) {
    console.error('Error during test:', error);
    console.log('❌ Event processing test failed!');
  }
}

// Function to test the status endpoint
async function testStatusEndpoint() {
  console.log('\n=== Testing Status Endpoint ===');
  
  try {
    const response = await fetch('http://localhost:8888/api/webhook-simple');
    const data = await response.json();
    
    console.log('Status response:', data);
    
    if (response.ok) {
      console.log('✅ Status endpoint test passed!');
    } else {
      console.log('❌ Status endpoint test failed!');
    }
  } catch (error) {
    console.error('Error during test:', error);
    console.log('❌ Status endpoint test failed!');
  }
}

// Main test function
async function runTests() {
  console.log('Starting tests...');
  console.log('Make sure your local development server is running with "npm run dev"');
  
  // Wait a bit to make sure everything is loaded
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  await testStatusEndpoint();
  await testConfigUpdate();
  await testNostrEvent();
  
  console.log('\nTests completed!');
}

// Run the tests
runTests().catch(error => {
  console.error('Test suite error:', error);
});
