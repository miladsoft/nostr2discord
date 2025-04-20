require('dotenv').config();
require('websocket-polyfill');
const { SimplePool, nip19, validateEvent, verifySignature } = require('nostr-tools');
const fetch = require('node-fetch');

// In-memory cache for state between function invocations
// Note: This is reset when Netlify redeploys your function!
const cache = {
  lastSeen: 0,
  processedEvents: new Set(),
  userMetadata: null,
  lastRunTimestamp: 0
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

// Helper functions for reply detection and handling
function isReply(event) {
  if (!event || !event.tags) return false;
  return event.tags.some(tag => tag[0] === 'e');
}

function getReplyToEventId(event) {
  if (!event || !event.tags) return null;
  const eTag = event.tags.find(tag => tag[0] === 'e');
  return eTag ? eTag[1] : null;
}

// Fetch the original event being replied to
async function fetchOriginalEvent(eventId, relayUrls) {
  if (!eventId) return null;
  
  try {
    const pool = new SimplePool({ eoseSubTimeout: 3000 });
    
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
        // Keep waiting in case event comes late
      });
    });
  } catch (error) {
    console.error('Error fetching original event:', error);
    return null;
  }
}

// Format content for Discord with reply support
function formatForDiscord(event, userMetadata, originalEvent = null, originalAuthor = null) {
  const noteId = nip19.noteEncode(event.id);
  const timestamp = new Date(event.created_at * 1000).toISOString();
  
  const username = userMetadata?.name || userMetadata?.display_name || "Nostr User";
  const avatarUrl = userMetadata?.picture || "https://nostr.com/img/nostr-logo.png";

  // Get links based on configuration  
  const primalLink = `https://primal.net/e/${noteId}`;
  const notesLink = `https://notes.blockcore.net/e/${event.id}`;
  const nostrAtLink = `https://nostr.at/${noteId}`;
  
  // Determine which links to show based on config
  const preferredClient = process.env.PREFERRED_CLIENT || 'all';
  let linksText = '';
  
  if (preferredClient === 'primal') {
    linksText = `🔗 View on Primal: ${primalLink}`;
  } 
  else if (preferredClient === 'notes') {
    linksText = `🔗 View on Blockcore Notes: ${notesLink}`;
  }
  else if (preferredClient === 'nostr_at') {
    linksText = `🔗 View on nostr.at: ${nostrAtLink}`;
  }
  else {
    linksText = `🔗 View on: [Primal](${primalLink}) | [Notes](${notesLink}) | [nostr.at](${nostrAtLink})`;
  }

  // Create Discord embed
  const embed = {
    description: event.content,
    color: isReply(event) ? 15105570 : 3447003, // Orange for replies, blue for regular posts
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
  
  // Add reply context if this is a reply and we have the original post
  if (isReply(event) && originalEvent) {
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
  }
  
  // Create message payload
  const message = {
    username: username,
    avatar_url: avatarUrl,
    embeds: [embed]
  };
  
  return message;
}

// Modified function to handle replies with improved error handling
async function sendToDiscord(event, userMetadata, webhookUrl) {
  try {
    if (!webhookUrl) {
      console.error("No Discord webhook URL provided");
      return { success: false, error: "No Discord webhook URL provided" };
    }
    
    // Check if this is a reply and get the original post if needed
    let originalEvent = null;
    let originalAuthorMetadata = null;
    
    if (isReply(event)) {
      const replyToId = getReplyToEventId(event);
      console.log(`Processing reply to event ${replyToId?.slice(0, 8) || 'unknown'}`);
      
      const config = getConfig();
      if (replyToId) {
        originalEvent = await fetchOriginalEvent(replyToId, config.relayUrls);
        
        if (originalEvent && originalEvent.pubkey) {
          originalAuthorMetadata = await fetchUserMetadata(originalEvent.pubkey, config.relayUrls);
        }
      }
    }
    
    const discordMessage = formatForDiscord(event, userMetadata, originalEvent, originalAuthorMetadata);
    
    console.log(`Sending ${isReply(event) ? 'reply' : 'post'} to Discord: ${event.id.slice(0, 8)}...`);
    console.log(`Content preview: ${event.content.substring(0, 50)}${event.content.length > 50 ? '...' : ''}`);
    
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(discordMessage),
      });
      
      if (response.ok) {
        console.log(`✅ Successfully sent ${isReply(event) ? 'reply' : 'event'} to Discord`);
        return { success: true };
      } else {
        const errorText = await response.text();
        console.error(`❌ Discord API error: ${response.status} ${response.statusText}`);
        console.error(`Response body: ${errorText}`);
        
        // If rate limited, provide retryAfter information
        if (response.status === 429) {
          const retryAfter = response.headers.get('retry-after');
          return {
            success: false,
            error: `Discord rate limit exceeded. Retry after ${retryAfter} seconds.`,
            retryAfter: parseInt(retryAfter || '5', 10)
          };
        }
        
        return { 
          success: false, 
          error: `Discord API error: ${response.status} ${response.statusText}`,
          details: errorText
        };
      }
    } catch (fetchError) {
      console.error(`❌ Network error sending to Discord:`, fetchError);
      return { success: false, error: fetchError.message || 'Network error' };
    }
  } catch (error) {
    console.error('❌ Error in sendToDiscord:', error);
    return { success: false, error: error.message || 'Unknown error' };
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

// Check if an event has been processed already
function isEventProcessed(event) {
  // Check in-memory cache
  if (cache.processedEvents.has(event.id)) {
    return true;
  }
  
  // Validate event hash as a security check
  const calculatedHash = getEventHash(event);
  if (calculatedHash !== event.id) {
    console.error(`Event ${event.id.slice(0, 8)}... has invalid hash`);
    return true; // Reject invalid events
  }
  
  // If we've seen this event before (based on timestamps), reject it
  // This helps prevent duplicate posts after cold starts
  const lastRun = cache.lastRunTimestamp;
  if (lastRun > 0) {
    // If the event is older than our last run by more than 5 minutes,
    // and it's not in our recently seen window, it's likely a duplicate
    const eventTime = event.created_at * 1000; // Convert to milliseconds
    const LOOKBACK_WINDOW = 5 * 60 * 1000; // 5 minutes
    
    if (eventTime < lastRun - LOOKBACK_WINDOW && eventTime > cache.lastSeen * 1000 - 60000) {
      console.log(`Event ${event.id.slice(0, 8)}... is likely a duplicate (created: ${new Date(eventTime).toISOString()})`);
      cache.processedEvents.add(event.id); // Add it to processed events
      return true;
    }
  }
  
  return false;
}

// Poll for new events since last check
async function pollForEvents() {
  const config = getConfig();
  
  // Validate configuration
  if (!config.pubkey) {
    console.error("No Nostr pubkey configured");
    return { error: "No Nostr pubkey configured" };
  }
  
  if (!config.discordWebhookUrl) {
    console.error("No Discord webhook URL configured");
    return { error: "No Discord webhook URL configured" };
  }
  
  console.log(`Configuration: ${JSON.stringify({
    pubkey: config.pubkey.slice(0, 8) + '...',
    webhook: config.discordWebhookUrl.substring(0, 20) + '...',
    relays: config.relayUrls,
    preferredClient: config.preferredClient
  }, null, 2)}`);
  
  // Convert npub to hex if needed
  let pubkey = config.pubkey;
  if (pubkey.startsWith('npub')) {
    try {
      const decoded = nip19.decode(pubkey);
      pubkey = decoded.data;
      console.log(`Converted npub to hex: ${pubkey}`);
    } catch (error) {
      console.error("Invalid npub format:", error);
      return { error: "Invalid npub format" };
    }
  }
  
  // Calculate time window
  const now = Math.floor(Date.now() / 1000);
  const since = cache.lastSeen > 0 ? cache.lastSeen : now - config.lookbackSeconds; 
  
  console.log(`Polling for events from ${pubkey} since ${new Date(since * 1000).toISOString()}`);
  
  try {
    const pool = new SimplePool({ eoseSubTimeout: 5000 });
    
    // Try to connect to each relay to check connectivity
    console.log("Testing relay connections...");
    for (const relay of config.relayUrls) {
      try {
        console.log(`Checking relay: ${relay}`);
        const events = await pool.list([relay], [{
          authors: [pubkey],
          kinds: [0],
          limit: 1
        }], { timeout: 3000 });
        
        console.log(`Relay ${relay}: ${events.length > 0 ? 'working' : 'no data'}`);
      } catch (error) {
        console.error(`Relay ${relay} check failed:`, error.message || 'Unknown error');
      }
    }
    
    const userMetadata = await fetchUserMetadata(pubkey, config.relayUrls);
    console.log(`User metadata: ${JSON.stringify(userMetadata)}`);
    
    // Subscribe for events since last poll
    const filter = {
      authors: [pubkey],
      kinds: [1], // Text notes only
      since: since,
    };
    
    console.log(`Using filter: ${JSON.stringify(filter)}`);
    
    const events = await pool.list(config.relayUrls, [filter], { timeout: 10000 });
    console.log(`Found ${events.length} events`);
    
    // If no events from primary relays, try fallback relays
    if (events.length === 0) {
      console.log("No events found with primary relays, trying fallback relays...");
      const fallbackRelays = [
        'wss://purplepag.es',
        'wss://relay.nostr.band',
        'wss://relay.snort.social'
      ];
      
      const fallbackEvents = await pool.list(fallbackRelays, [filter], { timeout: 8000 });
      console.log(`Found ${fallbackEvents.length} events from fallback relays`);
      
      // Add any new events from fallback relays
      for (const event of fallbackEvents) {
        if (!events.some(e => e.id === event.id)) {
          events.push(event);
        }
      }
      
      console.log(`Total events after fallback: ${events.length}`);
    }
    
    const results = [];
    let newLastSeen = since;
    
    // Update the last run timestamp
    cache.lastRunTimestamp = Date.now();
    
    // Process events in order
    const sortedEvents = events.sort((a, b) => a.created_at - b.created_at);
    
    for (const event of sortedEvents) {
      // Update last seen timestamp
      if (event.created_at > newLastSeen) {
        newLastSeen = event.created_at;
      }
      
      console.log(`Processing event ${event.id.slice(0, 8)}... created at ${new Date(event.created_at * 1000).toISOString()}`);
      
      // Skip if we've already processed this event
      if (cache.processedEvents.has(event.id)) {
        console.log(`Skipping already processed event ${event.id.slice(0, 8)}...`);
        continue;
      }
      
      // Validate event
      try {
        if (!validateEvent(event)) {
          console.log(`Skipping invalid event ${event.id.slice(0, 8)}...`);
          continue;
        }
        
        if (!verifySignature(event)) {
          console.log(`Skipping event with invalid signature ${event.id.slice(0, 8)}...`);
          continue;
        }
      } catch (validationError) {
        console.error(`Error validating event ${event.id.slice(0, 8)}:`, validationError);
        continue;
      }
      
      // Test Discord webhook before sending
      try {
        const testResponse = await fetch(config.discordWebhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content: `Testing webhook connectivity before sending events (${new Date().toISOString()})`
          }),
        });
        
        if (!testResponse.ok) {
          console.error(`Discord webhook test failed: ${testResponse.status} ${testResponse.statusText}`);
          const errorText = await testResponse.text();
          console.error(`Response: ${errorText}`);
          return {
            error: `Discord webhook test failed: ${testResponse.status} ${testResponse.statusText}`,
            details: errorText
          };
        } else {
          console.log("Discord webhook test successful");
        }
      } catch (testError) {
        console.error("Error testing Discord webhook:", testError);
        return { error: `Discord webhook test error: ${testError.message}` };
      }
      
      // Send to Discord
      const result = await sendToDiscord(event, userMetadata, config.discordWebhookUrl);
      
      if (result.success) {
        // Mark as processed
        cache.processedEvents.add(event.id);
        results.push({ id: event.id, status: 'sent' });
        
        // Limit the size of the processed set
        if (cache.processedEvents.size > 200) {
          const firstItem = cache.processedEvents.values().next().value;
          cache.processedEvents.delete(firstItem);
        }
      } else {
        console.error(`Failed to send event ${event.id.slice(0, 8)} to Discord:`, result.error);
        results.push({ id: event.id, status: 'failed', error: result.error });
      }
    }
    
    // Update the last seen timestamp for next poll
    cache.lastSeen = newLastSeen;
    
    return { 
      success: true, 
      processed: results.length,
      events: results,
      lastSeen: new Date(cache.lastSeen * 1000).toISOString()
    };
  } catch (error) {
    console.error("Error polling for events:", error);
    return { 
      error: error.message || "Unknown error", 
      lastSeen: cache.lastSeen ? new Date(cache.lastSeen * 1000).toISOString() : 'never'
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
