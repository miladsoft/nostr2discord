require('dotenv').config();
require('websocket-polyfill');
const { nip19, relayInit } = require('nostr-tools');
const { sendToDiscord } = require('./index');

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
  const relays = process.env.NOSTR_RELAYS;

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

runTests().catch(error => {
  console.error("Test failed with error:", error ? (error.message || error.toString()) : 'Unknown error');
});
