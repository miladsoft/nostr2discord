require('dotenv').config();
const { SimplePool, nip19, validateEvent, verifySignature, getEventHash } = require('nostr-tools');
const fetch = require('node-fetch');

// Configuration (gets updated per request)
let config = {
  relayUrls: (process.env.NOSTR_RELAYS || 'wss://relay.nostr.band,wss://relay.damus.io').split(','),
  pubkey: process.env.NOSTR_PUBKEY || '',
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
  preferredClient: process.env.PREFERRED_CLIENT || 'all',
  processedEvents: new Set(),
  lastProcessedTimestamp: Date.now()
};

// Function to check if event has been processed
function isEventProcessed(event) {
  // Check in memory cache first (fast)
  if (config.processedEvents.has(event.id)) {
    console.log(`[DUPLICATE] Event ${event.id.slice(0, 8)}... found in memory cache`);
    return true;
  }
  
  // Check event hash to ensure integrity
  const calculatedHash = getEventHash(event);
  if (calculatedHash !== event.id) {
    console.log(`[REJECT] Event ${event.id.slice(0, 8)}... has invalid hash`);
    return true; // Reject events with mismatched hashes
  }
  
  // Time-based filtering - reject events that are older than 1 hour
  const eventTime = event.created_at * 1000; // Convert to milliseconds
  const ONE_HOUR = 60 * 60 * 1000;
  
  if (Date.now() - eventTime > ONE_HOUR) {
    console.log(`[REJECT] Event ${event.id.slice(0, 8)}... is too old (${new Date(eventTime).toISOString()})`);
    return true;
  }
  
  // Check if this event is older than our last processed timestamp and close in time
  // This helps after cold starts to avoid reprocessing recent events
  const lastTime = config.lastProcessedTimestamp;
  const FIVE_MINUTES = 5 * 60 * 1000;
  
  if (eventTime < lastTime && lastTime - eventTime < FIVE_MINUTES) {
    console.log(`[DUPLICATE] Event ${event.id.slice(0, 8)}... likely processed in previous instance`);
    markEventProcessed(event.id);
    return true;
  }
  
  return false;
}

// Function to mark event as processed
function markEventProcessed(eventId) {
  config.processedEvents.add(eventId);
  config.lastProcessedTimestamp = Date.now();
  
  // Limit the size of processedEvents
  if (config.processedEvents.size > 200) {
    const iterator = config.processedEvents.values();
    config.processedEvents.delete(iterator.next().value);
  }
}

// Get viewer links based on configuration
function getViewerLinks(eventId) {
  const noteId = nip19.noteEncode(eventId);
  
  const primalLink = `https://primal.net/e/${noteId}`;
  const notesLink = `https://notes.blockcore.net/e/${eventId}`;
  const nostrAtLink = `https://nostr.at/${noteId}`;
  
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
  else if (config.preferredClient === 'nostr_at') {
    linksText = `🔗 View on nostr.at: ${nostrAtLink}`;
    preferredLink = nostrAtLink;
  }
  else {
    // Default to showing all
    linksText = `🔗 View on: [Primal](${primalLink}) | [Blockcore Notes](${notesLink}) | [nostr.at](${nostrAtLink})`;
    preferredLink = primalLink;
  }
  
  return { linksText, preferredLink };
}

// Check if an event is a reply
function isReply(event) {
  if (!event || !event.tags) return false;
  
  // Look for "e" tags which reference other events (standard way to mark replies)
  return event.tags.some(tag => tag[0] === 'e');
}

// Get the event ID that this post is replying to
function getReplyToEventId(event) {
  if (!event || !event.tags) return null;
  
  // Find the first "e" tag - this is the event being replied to
  const eTag = event.tags.find(tag => tag[0] === 'e');
  return eTag ? eTag[1] : null; // The second item is the event ID
}

// Get the pubkey of the original post author if available
function getReplyToPubkey(event) {
  if (!event || !event.tags) return null;
  
  // Find "p" tags which reference pubkeys
  const pTag = event.tags.find(tag => tag[0] === 'p');
  return pTag ? pTag[1] : null;
}

// Fetch original event details for a reply
async function fetchOriginalEvent(eventId, relayUrls) {
  if (!eventId) return null;
  
  try {
    const pool = new SimplePool({ eoseSubTimeout: 3000 });
    
    // Create a subscription to find the original event
    const sub = pool.sub(relayUrls, [{
      ids: [eventId],
      limit: 1
    }]);
    
    return new Promise((resolve) => {
      let timeout = setTimeout(() => {
        sub.unsub();
        resolve(null);
      }, 3000);
      
      sub.on('event', event => {
        clearTimeout(timeout);
        sub.unsub();
        resolve(event);
      });
      
      sub.on('eose', () => {
        // Keep waiting in case event comes in late
      });
    });
  } catch (error) {
    console.error('Error fetching original event:', error);
    return null;
  }
}

// Format Nostr content for Discord with enhanced reply support
function formatForDiscord(event, userMetadata, originalEvent = null, originalAuthor = null) {
  let content = event.content;
  const viewerLinks = getViewerLinks(event.id);
  const timestamp = new Date(event.created_at * 1000).toISOString();
  
  const username = userMetadata?.name || userMetadata?.display_name || "Nostr User";
  const avatarUrl = userMetadata?.picture || "https://nostr.com/img/nostr-logo.png";
  
  // Create base embed
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
  
  // Add reply context if this is a reply
  if (isReply(event) && originalEvent) {
    // Prepare the author name for the original post
    const originalAuthorName = originalAuthor?.name || 
                              originalAuthor?.display_name || 
                              (originalEvent.pubkey ? `${originalEvent.pubkey.slice(0, 8)}...` : "Unknown User");
    
    // Truncate original content if too long
    let originalContent = originalEvent.content || '';
    if (originalContent.length > 100) {
      originalContent = originalContent.substring(0, 97) + '...';
    }
    
    // Add this as the first field for better visibility
    embed.fields.unshift({
      name: `💬 Reply to post by ${originalAuthorName}`,
      value: originalContent
    });
    
    // Change the embed color to distinguish replies
    embed.color = 15105570; // Orange color
  }
  
  const message = {
    username: username,
    avatar_url: avatarUrl,
    embeds: [embed]
  };
  
  return message;
}

// Test the Discord webhook connection
async function testDiscordWebhook() {
  try {
    // Do not send any test messages to Discord
    console.log(`Webhook test requested, but all test messages are permanently disabled`);
    return { message: "Test messages are disabled for this webhook", disabled: true };
  } catch (error) {
    console.error(`❌ Exception during webhook validation:`, error);
    return { success: false, error: error.message || 'Unknown error' };
  }
}

// Improved send to Discord with better error handling
async function sendToDiscord(event, userMetadata, originalEvent = null, originalAuthorMetadata = null) {
  try {
    if (isEventProcessed(event)) {
      console.log(`Event ${event.id.slice(0, 8)}... already processed, skipping`);
      return { success: true, status: 'already_processed' };
    }
    
    if (!config.discordWebhookUrl) {
      console.error("ERROR: Discord webhook URL is not configured properly");
      return { success: false, error: 'No Discord webhook URL configured' };
    }
    
    const discordMessage = formatForDiscord(event, userMetadata, originalEvent, originalAuthorMetadata);
    
    console.log(`Sending ${isReply(event) ? 'reply' : 'post'} to Discord: ${event.id.slice(0, 8)}...`);
    console.log(`Content preview: ${event.content.substring(0, 50)}${event.content.length > 50 ? '...' : ''}`);
    console.log(`Using webhook URL: ${config.discordWebhookUrl.substring(0, 30)}...`);
    
    try {
      const response = await fetch(config.discordWebhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(discordMessage),
      });
      
      const responseText = await response.text();
      
      if (response.ok) {
        console.log(`✅ Successfully sent ${isReply(event) ? 'reply' : 'event'} ${event.id.slice(0, 8)}... to Discord`);
        markEventProcessed(event.id);
        return { success: true, status: 'sent' };
      } else {
        console.error(`❌ Discord API error: ${response.status} ${response.statusText}`);
        console.error(`Response body: ${responseText}`);
        
        // If we got rate limited, return a special error
        if (response.status === 429) {
          const retryAfter = response.headers.get('retry-after') || '5';
          return { 
            success: false, 
            error: 'Discord rate limit exceeded', 
            retryAfter: parseInt(retryAfter, 10),
            details: responseText
          };
        }
        
        return { 
          success: false, 
          error: `Discord API error: ${response.status} ${response.statusText}`,
          details: responseText
        };
      }
    } catch (fetchError) {
      console.error('❌ Network error sending to Discord:', fetchError);
      return { success: false, error: fetchError.message || 'Network error' };
    }
  } catch (error) {
    console.error('❌ Error in sendToDiscord:', error);
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
  console.log(`Processing event: ${JSON.stringify(event, null, 2)}`);
  
  // Validate the event
  if (!validateEvent(event)) {
    console.error("Event validation failed");
    return { success: false, error: 'Event validation failed' };
  }
  
  if (!verifySignature(event)) {
    console.error("Signature verification failed");
    return { success: false, error: 'Signature verification failed' };
  }
  
  // Only process kind 1 events (text notes)
  if (event.kind === 1) {
    // First fetch the user metadata
    const userMetadata = await fetchUserMetadata(event.pubkey);
    console.log(`User metadata: ${JSON.stringify(userMetadata)}`);
    
    // Check if this is a reply
    if (isReply(event)) {
      const replyToId = getReplyToEventId(event);
      console.log(`Event ${event.id.slice(0, 8)}... is a reply to ${replyToId?.slice(0, 8)}...`);
      
      // Fetch the original post and its author's metadata
      const originalEvent = await fetchOriginalEvent(replyToId, config.relayUrls);
      let originalAuthorMetadata = null;
      
      if (originalEvent) {
        originalAuthorMetadata = await fetchUserMetadata(originalEvent.pubkey);
        console.log(`Found original post by ${originalEvent.pubkey.slice(0, 8)}...`);
      }
      
      // Now send to Discord with the additional context
      return await sendToDiscord(event, userMetadata, originalEvent, originalAuthorMetadata);
    } else {
      // Regular post (not a reply)
      return await sendToDiscord(event, userMetadata);
    }
  } else {
    console.log(`Skipping event with kind ${event.kind} (only kind 1 is supported)`);
    return { success: false, error: 'Unsupported event kind' };
  }
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
    const params = event.queryStringParameters || {};
    
    // Check if this is a test request
    if (params.action === 'test') {
      console.log('Received test request for Discord webhook');
      const testResult = await testDiscordWebhook();
      return {
        statusCode: testResult.success ? 200 : 500,
        headers,
        body: JSON.stringify(testResult)
      };
    }
    
    // Regular status response
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        status: 'active',
        config: {
          pubkey: config.pubkey ? (config.pubkey.slice(0, 8) + '...' + config.pubkey.slice(-8)) : 'Not set',
          relays: config.relayUrls,
          preferredClient: config.preferredClient,
          discordWebhook: config.discordWebhookUrl ? 'Configured' : 'Not set',
          processedEvents: config.processedEvents.size,
          lastProcessed: new Date(config.lastProcessedTimestamp).toISOString()
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
        console.log(`Processing Nostr event: ${payload.id.slice(0, 8)}...`);
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
      console.error("Error processing request:", error);
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
