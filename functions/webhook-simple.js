require('dotenv').config();
const { SimplePool, nip19, validateEvent, verifySignature } = require('nostr-tools');
const fetch = require('node-fetch');

// Configuration (gets updated per request)
let config = {
  relayUrls: (process.env.NOSTR_RELAYS || 'wss://relay.nostr.band,wss://relay.damus.io').split(','),
  pubkey: process.env.NOSTR_PUBKEY || '',
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
  preferredClient: process.env.PREFERRED_CLIENT || 'all',
  processedEvents: new Set()
};

// Function to check if event has been processed
function isEventProcessed(eventId) {
  return config.processedEvents.has(eventId);
}

// Function to mark event as processed
function markEventProcessed(eventId) {
  config.processedEvents.add(eventId);
  // Limit the size of processedEvents
  if (config.processedEvents.size > 100) {
    const iterator = config.processedEvents.values();
    config.processedEvents.delete(iterator.next().value);
  }
}

// Get viewer links based on configuration
function getViewerLinks(eventId) {
  const noteId = nip19.noteEncode(eventId);
  
  const primalLink = `https://primal.net/e/${noteId}`;
  const notesLink = `https://notes.blockcore.net/e/${eventId}`;
  const njumpLink = `https://njump.me/${noteId}`;
  
  let linksText = '';
  let preferredLink = '';
  
  if (config.preferredClient === 'primal') {
    linksText = `🔗 View on Primal: ${primalLink}`;
    preferredLink = primalLink;
  } 
  else if (config.preferredClient === 'notes') {
    linksText = `🔗 View on Blockcore Notes: ${notesLink}`;
    preferredLink = notesLink;
  }
  else if (config.preferredClient === 'njump') {
    linksText = `🔗 View on njump: ${njumpLink}`;
    preferredLink = njumpLink;
  }
  else {
    // Default to showing all
    linksText = `🔗 View on: [Primal](${primalLink}) | [Blockcore Notes](${notesLink}) | [njump](${njumpLink})`;
    preferredLink = primalLink;
  }
  
  return { linksText, preferredLink };
}

// Format Nostr content for Discord
function formatForDiscord(event, userMetadata) {
  let content = event.content;
  const viewerLinks = getViewerLinks(event.id);
  const timestamp = new Date(event.created_at * 1000).toISOString();
  
  const username = userMetadata?.name || userMetadata?.display_name || "Nostr User";
  const avatarUrl = userMetadata?.picture || "https://nostr.com/img/nostr-logo.png";
  
  const embed = {
    description: content,
    color: 3447003,
    timestamp: timestamp,
    footer: {
      text: `Nostr Event`
    },
    fields: [
      {
        name: "View in clients",
        value: viewerLinks.linksText
      }
    ]
  };
  
  const message = {
    username: username,
    avatar_url: avatarUrl,
    embeds: [embed]
  };
  
  return message;
}

// Send event to Discord webhook
async function sendToDiscord(event, userMetadata) {
  try {
    if (isEventProcessed(event.id)) {
      console.log(`Event ${event.id.slice(0, 8)}... already processed, skipping`);
      return { success: true, status: 'already_processed' };
    }
    
    const discordMessage = formatForDiscord(event, userMetadata);
    
    const response = await fetch(config.discordWebhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(discordMessage),
    });
    
    if (response.ok) {
      console.log(`Successfully sent event ${event.id.slice(0, 8)}... to Discord`);
      markEventProcessed(event.id);
      return { success: true, status: 'sent' };
    } else {
      console.error(`Failed to send to Discord: ${response.statusText}`);
      return { success: false, error: response.statusText };
    }
  } catch (error) {
    console.error('Error sending to Discord:', error);
    return { success: false, error: error.message || 'Unknown error' };
  }
}

// Fetch user metadata
async function fetchUserMetadata(pubkey) {
  if (!pubkey) return null;
  
  try {
    const pool = new SimplePool({ eoseSubTimeout: 3000 });
    
    // Create a subscription for kind 0 (metadata) events
    const metadataSub = pool.sub(config.relayUrls, [{
      kinds: [0],
      authors: [pubkey],
      limit: 1
    }]);
    
    return new Promise((resolve) => {
      let timeout = setTimeout(() => {
        metadataSub.unsub();
        resolve(null);
      }, 3000);
      
      metadataSub.on('event', event => {
        try {
          clearTimeout(timeout);
          const metadata = JSON.parse(event.content);
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
    return null;
  }
}

// Process a Nostr event
async function processNostrEvent(event) {
  // Validate the event
  if (!validateEvent(event) || !verifySignature(event)) {
    return { success: false, error: 'Invalid event' };
  }
  
  // Fetch user metadata if it's a kind 1 event (text note)
  if (event.kind === 1) {
    const userMetadata = await fetchUserMetadata(event.pubkey);
    return await sendToDiscord(event, userMetadata);
  }
  
  return { success: false, error: 'Unsupported event kind' };
}

// Update configuration
function updateConfig(newConfig) {
  if (newConfig.nostrPubkey) {
    // Convert npub to hex if needed
    let pubkey = newConfig.nostrPubkey;
    if (pubkey.startsWith('npub')) {
      try {
        const decoded = nip19.decode(pubkey);
        pubkey = decoded.data;
      } catch (error) {
        return { success: false, error: 'Invalid npub format' };
      }
    }
    config.pubkey = pubkey;
  }
  
  if (newConfig.discordWebhook) {
    config.discordWebhookUrl = newConfig.discordWebhook;
  }
  
  if (newConfig.relays) {
    config.relayUrls = newConfig.relays.split(',');
  }
  
  if (newConfig.preferredClient) {
    config.preferredClient = newConfig.preferredClient;
  }
  
  return { success: true, config: { 
    pubkey: config.pubkey, 
    relays: config.relayUrls.join(','),
    preferredClient: config.preferredClient
  }};
}

// Main handler for Netlify function
exports.handler = async function(event, context) {
  // Enable CORS
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };
  
  // Handle OPTIONS request for CORS
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers,
      body: ''
    };
  }
  
  // GET request - return status
  if (event.httpMethod === 'GET') {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        status: 'active',
        config: {
          pubkey: config.pubkey ? (config.pubkey.slice(0, 8) + '...' + config.pubkey.slice(-8)) : 'Not set',
          relays: config.relayUrls,
          preferredClient: config.preferredClient,
          discordWebhook: config.discordWebhookUrl ? 'Configured' : 'Not set'
        }
      })
    };
  }
  
  // POST request - process Nostr event or update config
  if (event.httpMethod === 'POST') {
    try {
      const payload = JSON.parse(event.body);
      console.log("Received payload:", JSON.stringify(payload));
      
      // If payload contains a Nostr event
      if (payload.id && payload.pubkey && payload.sig) {
        const result = await processNostrEvent(payload);
        return {
          statusCode: result.success ? 200 : 400,
          headers,
          body: JSON.stringify(result)
        };
      }
      
      // If payload contains configuration update
      if (payload.nostrPubkey || payload.discordWebhook || payload.relays || payload.preferredClient) {
        const result = updateConfig(payload);
        return {
          statusCode: result.success ? 200 : 400,
          headers,
          body: JSON.stringify(result)
        };
      }
      
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, error: 'Invalid payload' })
      };
    } catch (error) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ success: false, error: error.message || 'Unknown error' })
      };
    }
  }
  
  // Unsupported method
  return {
    statusCode: 405,
    headers,
    body: JSON.stringify({ success: false, error: 'Method not allowed' })
  };
};
