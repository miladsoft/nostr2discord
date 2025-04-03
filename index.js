require('dotenv').config();
require('websocket-polyfill');
const { relayInit, nip19, SimplePool, getEventHash, validateEvent, verifySignature } = require('nostr-tools');
const fetch = require('node-fetch');

// Configuration from environment variables
const relayUrls = (process.env.NOSTR_RELAYS || 'wss://relay.damus.io,wss://relay.nostr.info').split(',');
let pubkey = process.env.NOSTR_PUBKEY;
const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
const checkIntervalMs = parseInt(process.env.CHECK_INTERVAL_MS || '30000');
const debug = process.env.DEBUG === 'true';

// Convert npub to hex if needed
if (pubkey && pubkey.startsWith('npub')) {
  try {
    const decoded = nip19.decode(pubkey);
    pubkey = decoded.data;
    console.log(`Converted npub to hex: ${pubkey}`);
  } catch (error) {
    console.error(`Failed to decode npub: ${error ? (error.message || error.toString()) : 'Unknown error'}`);
  }
}

console.log("=== NOSTR2DISCORD BOT STARTING ===");
console.log(`Configured with pubkey: ${pubkey ? pubkey : 'NOT SET'}`);
console.log(`Discord webhook: ${discordWebhookUrl ? 'CONFIGURED' : 'NOT SET'}`);
console.log(`Connecting to relays: ${relayUrls.join(', ')}`);
console.log(`Debug mode: ${debug ? 'ON' : 'OFF'}`);

// Initialize a relay pool with longer timeout
const pool = new SimplePool({ eoseSubTimeout: 10000 }); // Increase EOSE timeout to 10s

// Store for processed events to prevent duplicates
const processedEvents = new Set();

// Debug logging function
function logDebug(message) {
  if (debug) {
    console.log(`[DEBUG] ${message}`);
  }
}

// Format Nostr content for Discord
function formatForDiscord(event) {
  // Convert mentions, links, etc.
  let content = event.content;
  
  // Handle mentions (NIP-08/NIP-27)
  content = content.replace(/nostr:npub[a-z0-9]+/g, match => {
    try {
      const decoded = nip19.decode(match.slice(6));
      return `*@${decoded.data.slice(0, 8)}*`;
    } catch (e) {
      return match;
    }
  });
  
  // Format the message for Discord
  const timestamp = new Date(event.created_at * 1000).toISOString();
  
  return {
    content: null,
    embeds: [
      {
        title: "New Nostr Post",
        description: content,
        color: 3447003, // Blue color
        footer: {
          text: `Event ID: ${event.id.slice(0, 8)}...`
        },
        timestamp: timestamp
      }
    ],
    username: `Nostr Relay Bot`,
    avatar_url: "https://nostr.com/img/nostr-logo.png" // Replace with actual Nostr logo if available
  };
}

// Send event to Discord webhook
async function sendToDiscord(event) {
  try {
    if (processedEvents.has(event.id)) {
      console.log(`Event ${event.id.slice(0, 8)}... already processed, skipping`);
      return;
    }
    
    const discordMessage = formatForDiscord(event);
    
    const response = await fetch(discordWebhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(discordMessage),
    });
    
    if (response.ok) {
      console.log(`Successfully sent event ${event.id.slice(0, 8)}... to Discord`);
      processedEvents.add(event.id);
      
      // Limit the size of the set to prevent memory issues
      if (processedEvents.size > 1000) {
        const firstItem = processedEvents.values().next().value;
        processedEvents.delete(firstItem);
      }
    } else {
      console.error(`Failed to send to Discord: ${response.statusText}`);
    }
  } catch (error) {
    console.error('Error sending to Discord:', error);
  }
}

// Debug function to check relay connection status
async function checkRelayConnections() {
  console.log("Testing relay connections...");
  
  const promises = relayUrls.map(url => {
    return new Promise(resolve => {
      try {
        const relay = relayInit(url);
        let timeoutId;
        
        logDebug(`Attempting to connect to ${url}...`);
        
        relay.on('connect', () => {
          clearTimeout(timeoutId);
          console.log(`✅ Connected to relay: ${url}`);
          resolve(true);
          relay.close();
        });
        
        relay.on('error', (err) => {
          clearTimeout(timeoutId);
          console.error(`❌ Failed to connect to relay: ${url}`, err ? err.toString() : 'Unknown error');
          resolve(false);
        });
        
        relay.connect().catch(err => {
          console.error(`❌ Connection error with ${url}:`, err ? err.toString() : 'Unknown error');
          resolve(false);
        });
        
        timeoutId = setTimeout(() => {
          console.log(`⏱️ Connection to ${url} timed out after 5s`);
          resolve(false);
          try {
            relay.close();
          } catch (e) {}
        }, 5000);
      } catch (error) {
        console.error(`❌ Error setting up relay ${url}:`, error ? (error.message || error.toString()) : 'Unknown error');
        resolve(false);
      }
    });
  });
  
  const results = await Promise.all(promises);
  const successfulConnections = results.filter(Boolean).length;
  
  console.log(`Connected to ${successfulConnections}/${relayUrls.length} relays`);
  
  if (successfulConnections === 0) {
    console.error("⚠️ WARNING: Could not connect to any relays. Events won't be received!");
  }
  
  return successfulConnections > 0;
}

// Subscribe to Nostr events
async function subscribeToNostrEvents() {
  if (!pubkey) {
    console.error('❌ No NOSTR_PUBKEY provided. Please set this environment variable.');
    return;
  }
  
  if (!discordWebhookUrl) {
    console.error('❌ No DISCORD_WEBHOOK_URL provided. Please set this environment variable.');
    return;
  }
  
  console.log(`🔔 Starting subscription to Nostr events for pubkey: ${pubkey}`);
  
  // First check our connections
  const connected = await checkRelayConnections();
  
  if (!connected) {
    console.error("Failed to connect to any relays. Retrying in 30 seconds...");
    setTimeout(subscribeToNostrEvents, 30000);
    return;
  }
  
  logDebug("Setting up subscription filter");
  
  // Subscribe to kind 1 (text note) events from the specified pubkey
  // Using a more comprehensive filter
  const filter = {
    authors: [pubkey],
    kinds: [1],
    limit: 20
  };
  
  logDebug(`Subscription filter: ${JSON.stringify(filter)}`);
  
  const sub = pool.sub(relayUrls, [filter]);
  
  console.log("Waiting for events...");
  
  let receivedEventCount = 0;
  
  sub.on('event', event => {
    receivedEventCount++;
    console.log(`📥 Received event ${receivedEventCount}: ${event.id.slice(0, 8)}... (created: ${new Date(event.created_at * 1000).toLocaleString()})`);
    logDebug(`Full event: ${JSON.stringify(event)}`);
    console.log(`📝 Content: ${event.content.substring(0, 100)}${event.content.length > 100 ? '...' : ''}`);
    
    // Validate the event
    let isValid = true;
    try {
      if (!validateEvent(event)) {
        console.error('❌ Event validation failed');
        isValid = false;
      }
      if (!verifySignature(event)) {
        console.error('❌ Signature verification failed');
        isValid = false;
      }
    } catch (error) {
      console.error('❌ Error during validation:', error);
      isValid = false;
    }
    
    if (!isValid) {
      console.error('❌ Invalid event received, skipping');
      return;
    }
    
    // Process the event
    sendToDiscord(event);
  });
  
  sub.on('eose', () => {
    console.log('📬 End of stored events. Now listening for new events...');
    if (receivedEventCount === 0) {
      console.log('⚠️ No events received. This could mean:');
      console.log('   - The pubkey has no recent posts');
      console.log('   - The pubkey might be incorrect');
      console.log('   - The relays don\'t have events for this pubkey');
      console.log('\nTrying to create a direct test connection to see event history...');
      
      // Let's attempt to fetch events directly using a single relay to debug
      testDirectFetch();
    }
  });
}

// Test function to directly fetch events from a single relay
async function testDirectFetch() {
  try {
    const testRelay = relayInit('wss://relay.damus.io');
    await testRelay.connect();
    
    testRelay.on('connect', () => {
      console.log("Connected to test relay. Requesting recent events...");
      
      const sub = testRelay.sub([
        {
          authors: [pubkey],
          limit: 5
        }
      ]);
      
      let count = 0;
      
      sub.on('event', event => {
        count++;
        console.log(`🔍 Test found event ${count}: ${event.kind} - ${new Date(event.created_at * 1000).toLocaleString()}`);
        console.log(`   Content: ${event.content.substring(0, 50)}${event.content.length > 50 ? '...' : ''}`);
      });
      
      sub.on('eose', () => {
        if (count === 0) {
          console.log("❌ No events found by direct test. The pubkey may be incorrect or has no events.");
        } else {
          console.log(`✅ Found ${count} events by direct test but subscription didn't receive them.`);
        }
        testRelay.close();
      });
    });
  } catch (error) {
    console.error("Error in direct test:", error);
  }
}

// Start the application
console.log("Starting Nostr2Discord...");
subscribeToNostrEvents().catch(error => {
  console.error("Error during subscription:", error);
});

// Keep the process alive
setInterval(() => {
  console.log('💓 Heartbeat check... Bot is running');
}, checkIntervalMs);

// Export for serverless functions
module.exports = { subscribeToNostrEvents, sendToDiscord };
