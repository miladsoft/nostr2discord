require('dotenv').config();
require('websocket-polyfill');
const { SimplePool, nip19, validateEvent, verifySignature } = require('nostr-tools');
const fetch = require('node-fetch');

// In-memory cache for state between function invocations
// Note: This is reset when Netlify redeploys your function!
const cache = {
  lastSeen: 0,
  processedEvents: new Set(),
  userMetadata: null
};

// Configuration from environment variables
const getConfig = () => {
  return {
    relayUrls: (process.env.NOSTR_RELAYS || 'wss://relay.damus.io,wss://relay.nostr.band').split(','),
    pubkey: process.env.NOSTR_PUBKEY,
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
    preferredClient: process.env.PREFERRED_CLIENT || 'all',
    lookbackSeconds: parseInt(process.env.LOOKBACK_SECONDS || '3600')
  };
};

// Format content for Discord
function formatForDiscord(event, userMetadata) {
  const noteId = nip19.noteEncode(event.id);
  const timestamp = new Date(event.created_at * 1000).toISOString();
  
  const username = userMetadata?.name || userMetadata?.display_name || "Nostr User";
  const avatarUrl = userMetadata?.picture || "https://nostr.com/img/nostr-logo.png";

  // Get links based on configuration  
  const primalLink = `https://primal.net/e/${noteId}`;
  const notesLink = `https://notes.blockcore.net/e/${event.id}`;
  const njumpLink = `https://njump.me/${noteId}`;
  
  // Determine which links to show based on config
  const preferredClient = process.env.PREFERRED_CLIENT || 'all';
  let linksText = '';
  
  if (preferredClient === 'primal') {
    linksText = `🔗 View on Primal: ${primalLink}`;
  } 
  else if (preferredClient === 'notes') {
    linksText = `🔗 View on Blockcore Notes: ${notesLink}`;
  }
  else if (preferredClient === 'njump') {
    linksText = `🔗 View on njump: ${njumpLink}`;
  }
  else {
    linksText = `🔗 View on: [Primal](${primalLink}) | [Notes](${notesLink}) | [njump](${njumpLink})`;
  }

  // Create Discord embed
  const embed = {
    description: event.content,
    color: 3447003, // Blue color
    timestamp: timestamp,
    footer: {
      text: `Nostr Event`
    },
    fields: [
      {
        name: "Links",
        value: linksText
      }
    ]
  };
  
  // Create message payload
  const message = {
    username: username,
    avatar_url: avatarUrl,
    embeds: [embed]
  };
  
  return message;
}

// Send event to Discord webhook
async function sendToDiscord(event, userMetadata, webhookUrl) {
  try {
    const discordMessage = formatForDiscord(event, userMetadata);
    
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(discordMessage),
    });
    
    if (response.ok) {
      console.log(`Successfully sent event ${event.id.slice(0, 8)}... to Discord`);
      return { success: true };
    } else {
      console.error(`Failed to send to Discord: ${response.status} ${response.statusText}`);
      return { 
        success: false, 
        error: `Discord API Error: ${response.status} ${response.statusText}`
      };
    }
  } catch (error) {
    console.error('Error sending to Discord:', error);
    return { 
      success: false, 
      error: error.message || 'Unknown error'
    };
  }
}

// Fetch user metadata
async function fetchUserMetadata(pubkey, relayUrls) {
  if (!pubkey) return null;
  
  try {
    const pool = new SimplePool({ eoseSubTimeout: 3000 }); // Short timeout for serverless
    
    // Try to get metadata from cache first
    if (cache.userMetadata) {
      return cache.userMetadata;
    }
    
    // Create a subscription for kind 0 (metadata) events
    const metadataSub = pool.sub(relayUrls, [{
      kinds: [0],
      authors: [pubkey],
      limit: 1
    }]);
    
    return new Promise((resolve) => {
      let timeout = setTimeout(() => {
        metadataSub.unsub();
        resolve(null);
      }, 3000); // Short timeout for serverless
      
      metadataSub.on('event', event => {
        try {
          clearTimeout(timeout);
          const metadata = JSON.parse(event.content);
          // Store in cache for next time
          cache.userMetadata = metadata;
          metadataSub.unsub();
          resolve(metadata);
        } catch (e) {
          resolve(null);
        }
      });
      
      metadataSub.on('eose', () => {
        // Keep timeout running
      });
    });
  } catch (error) {
    console.error("Error fetching metadata:", error);
    return null;
  }
}

// Poll for new events since last check
async function pollForEvents() {
  const config = getConfig();
  
  // Validate configuration
  if (!config.pubkey) {
    return { error: "No Nostr pubkey configured" };
  }
  
  if (!config.discordWebhookUrl) {
    return { error: "No Discord webhook URL configured" };
  }
  
  // Convert npub to hex if needed
  let pubkey = config.pubkey;
  if (pubkey.startsWith('npub')) {
    try {
      const decoded = nip19.decode(pubkey);
      pubkey = decoded.data;
    } catch (error) {
      return { error: "Invalid npub format" };
    }
  }
  
  // Calculate time window
  const now = Math.floor(Date.now() / 1000);
  const since = cache.lastSeen > 0 ? cache.lastSeen : now - config.lookbackSeconds; 
  
  console.log(`Polling for events from ${pubkey} since ${new Date(since * 1000).toISOString()}`);
  
  try {
    const pool = new SimplePool({ eoseSubTimeout: 5000 });
    const userMetadata = await fetchUserMetadata(pubkey, config.relayUrls);
    
    // Subscribe for events since last poll
    const filter = {
      authors: [pubkey],
      kinds: [1], // Text notes only
      since: since,
    };
    
    const events = await pool.list(config.relayUrls, [filter]);
    console.log(`Found ${events.length} events`);
    
    const results = [];
    let newLastSeen = since;
    
    // Process events in order
    const sortedEvents = events.sort((a, b) => a.created_at - b.created_at);
    
    for (const event of sortedEvents) {
      // Update last seen timestamp
      if (event.created_at > newLastSeen) {
        newLastSeen = event.created_at;
      }
      
      // Skip if we've already processed this event
      if (cache.processedEvents.has(event.id)) {
        console.log(`Skipping already processed event ${event.id.slice(0, 8)}...`);
        continue;
      }
      
      // Validate event
      if (!validateEvent(event) || !verifySignature(event)) {
        console.log(`Skipping invalid event ${event.id.slice(0, 8)}...`);
        continue;
      }
      
      // Send to Discord
      const result = await sendToDiscord(event, userMetadata, config.discordWebhookUrl);
      
      if (result.success) {
        // Mark as processed
        cache.processedEvents.add(event.id);
        results.push({ id: event.id, status: 'sent' });
        
        // Limit the size of the processed set
        if (cache.processedEvents.size > 100) {
          const firstItem = cache.processedEvents.values().next().value;
          cache.processedEvents.delete(firstItem);
        }
      } else {
        results.push({ id: event.id, status: 'failed', error: result.error });
      }
    }
    
    // Update the last seen timestamp for next poll
    cache.lastSeen = newLastSeen;
    
    return { 
      success: true, 
      processed: results.length,
      events: results
    };
  } catch (error) {
    console.error("Error polling for events:", error);
    return { 
      error: error.message || "Unknown error", 
      lastSeen: cache.lastSeen
    };
  }
}

// Main handler for scheduled function
exports.handler = async function(event, context) {
  try {
    // Handle OPTIONS requests for CORS
    if (event.httpMethod === 'OPTIONS') {
      return {
        statusCode: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
        },
        body: ''
      };
    }
    
    // Handle GET request for status
    if (event.httpMethod === 'GET') {
      return {
        statusCode: 200,
        body: JSON.stringify({
          status: 'active',
          lastPoll: cache.lastSeen > 0 ? new Date(cache.lastSeen * 1000).toISOString() : 'never',
          processedEvents: cache.processedEvents.size
        })
      };
    }
    
    // Manual polling trigger with POST
    const result = await pollForEvents();
    
    return {
      statusCode: result.error ? 500 : 200,
      body: JSON.stringify(result)
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message || "Unknown error"
      })
    };
  }
};
