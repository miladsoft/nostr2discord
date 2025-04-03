require('dotenv').config();
require('websocket-polyfill');
const { SimplePool, nip19 } = require('nostr-tools');

const pool = new SimplePool({ eoseSubTimeout: 10000 }); // Increase timeout

async function debugNostrEvents() {
  console.log("=== NOSTR EVENTS DEBUGGER ===");
  
  // Get configuration from environment variables
  const relayUrls = (process.env.NOSTR_RELAYS || 'wss://relay.damus.io,wss://relay.nostr.info').split(',');
  let pubkey = process.env.NOSTR_PUBKEY;
  
  // Check if pubkey is provided
  if (!pubkey) {
    console.error("❌ No NOSTR_PUBKEY provided. Please set this environment variable.");
    return;
  }
  
  // If pubkey is in npub format, decode it
  if (pubkey.startsWith('npub')) {
    try {
      const decoded = nip19.decode(pubkey);
      pubkey = decoded.data;
      console.log(`Decoded npub to hex: ${pubkey}`);
    } catch (error) {
      console.error(`Failed to decode npub: ${error ? (error.message || error.toString()) : 'Unknown error'}`);
      return;
    }
  }

  console.log(`Connecting to relays: ${relayUrls.join(', ')}`);
  console.log(`Looking for events from pubkey: ${pubkey}`);
  console.log("This will run for 60 seconds or until we find events...\n");

  let eventsFound = 0;
  
  // Subscribe to ALL kinds of events from the specified pubkey to debug
  const sub = pool.sub(relayUrls, [
    {
      authors: [pubkey],
      limit: 20
    }
  ]);
  
  sub.on('event', event => {
    eventsFound++;
    console.log(`\n===== EVENT ${eventsFound} =====`);
    console.log(`ID: ${event.id}`);
    console.log(`Kind: ${event.kind}`);
    console.log(`Created: ${new Date(event.created_at * 1000).toISOString()}`);
    console.log(`Content: ${event.content}`);
    if (event.tags && event.tags.length > 0) {
      console.log("Tags:");
      event.tags.forEach(tag => {
        console.log(`- ${tag.join(', ')}`);
      });
    }
    console.log("====================\n");
  });
  
  sub.on('eose', () => {
    console.log('End of stored events received.');
    if (eventsFound === 0) {
      console.log('\n⚠️  No events found. This could mean:');
      console.log('   - The pubkey has no events');
      console.log('   - The pubkey might be incorrect');
      console.log('   - The relays don\'t have events for this pubkey');
      console.log('\nTrying alternative relay: wss://purplepag.es');
      
      // Try with alternative relay
      const altSub = pool.sub(['wss://purplepag.es'], [
        {
          authors: [pubkey],
          limit: 10
        }
      ]);
      
      altSub.on('event', event => {
        eventsFound++;
        console.log(`\n===== EVENT ${eventsFound} (ALT RELAY) =====`);
        console.log(`ID: ${event.id}`);
        console.log(`Kind: ${event.kind}`);
        console.log(`Created: ${new Date(event.created_at * 1000).toISOString()}`);
        console.log(`Content: ${event.content}`);
      });
      
      altSub.on('eose', () => {
        console.log('End of stored events from alternative relay.');
      });
    }
  });
  
  // Keep running for 60 seconds then exit
  setTimeout(() => {
    console.log(`\nDebug session complete. Found ${eventsFound} events.`);
    process.exit(0);
  }, 60000);
}

debugNostrEvents().catch(error => {
  console.error("Error:", error ? (error.message || error.toString()) : 'Unknown error');
});
