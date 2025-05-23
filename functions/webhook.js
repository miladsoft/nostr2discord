require('dotenv').config();
require('websocket-polyfill');
const { SimplePool, nip19, getEventHash, validateEvent, verifySignature } = require('nostr-tools');
const fetch = require('node-fetch');

// In-memory cache for processed events (not persistent between function invocations)
const processedEvents = new Set();
let userMetadataCache = {};
let lastProcessedTime = Date.now();

// Netlify function handler
exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  
  // Handle preflight OPTIONS requests
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers,
      body: ''
    };
  }
  
  // Handle GET requests (status check)
  if (event.httpMethod === 'GET') {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        status: "active",
        message: "Nostr2Discord webhook is ready to receive events",
        processedEvents: processedEvents.size,
        lastProcessedTime: new Date(lastProcessedTime).toISOString()
      })
    };
  }
  
  // Handle POST requests (Nostr events)
  if (event.httpMethod === 'POST') {
    try {
      const payload = JSON.parse(event.body);
      
      // Validate that this is a Nostr event
      if (!payload.id || !payload.pubkey || !payload.content) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: "Invalid Nostr event format"
          })
        };
      }
      
      // Check if this event has been processed already
      if (isEventProcessed(payload)) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            status: "skipped",
            message: "Event already processed"
          })
        };
      }
      
      // Validate event signature and integrity
      if (!validateEvent(payload) || !verifySignature(payload)) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: "Invalid event signature or structure"
          })
        };
      }
      
      // Get Discord webhook URL from environment variable
      const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
      if (!discordWebhookUrl) {
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({
            error: "Discord webhook URL not configured"
          })
        };
      }
      
      // Format and send the event to Discord
      const result = await processAndSendEvent(payload, discordWebhookUrl);
      
      return {
        statusCode: result.success ? 200 : 500,
        headers,
        body: JSON.stringify(result)
      };
    } catch (error) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: error.message || "Unknown error"
        })
      };
    }
  }
  
  // Handle unsupported methods
  return {
    statusCode: 405,
    headers,
    body: JSON.stringify({
      error: "Method not allowed"
    })
  };
};

// Check if an event has been processed
function isEventProcessed(event) {
  // Check in memory cache
  if (processedEvents.has(event.id)) {
    console.log(`[DUPLICATE] Event ${event.id.slice(0, 8)}... found in memory cache`);
    return true;
  }
  
  // Verify event hash
  const calculatedHash = getEventHash(event);
  if (calculatedHash !== event.id) {
    console.log(`[REJECT] Event ${event.id.slice(0, 8)}... has invalid hash`);
    return true;
  }
  
  // Time-based deduplication
  const eventTime = event.created_at * 1000;
  const ONE_HOUR = 60 * 60 * 1000;
  
  // Reject events that are too old
  if (Date.now() - eventTime > ONE_HOUR) {
    console.log(`[REJECT] Event ${event.id.slice(0, 8)}... is too old`);
    return true;
  }
  
  return false;
}

// Check if an event is a reply
function isReply(event) {
  if (!event || !event.tags) return false;
  return event.tags.some(tag => tag[0] === 'e');
}

// Get the event ID this post is replying to
function getReplyToEventId(event) {
  if (!event || !event.tags) return null;
  const eTag = event.tags.find(tag => tag[0] === 'e');
  return eTag ? eTag[1] : null;
}

// Fetch original event details
async function fetchOriginalEvent(eventId) {
  if (!eventId) return null;
  
  try {
    const relayUrls = (process.env.NOSTR_RELAYS || 'wss://relay.damus.io,wss://relay.nostr.band').split(',');
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
        // Keep waiting
      });
    });
  } catch (error) {
    console.error('Error fetching original event:', error);
    return null;
  }
}

// Process and send event to Discord with reply handling
async function processAndSendEvent(event, webhookUrl) {
  try {
    // Get user metadata
    let userMetadata = userMetadataCache[event.pubkey];
    if (!userMetadata) {
      userMetadata = await fetchUserMetadata(event.pubkey);
      if (userMetadata) {
        userMetadataCache[event.pubkey] = userMetadata;
      }
    }
    
    // Check if this is a reply and get original post info if needed
    let originalEvent = null;
    let originalAuthorMetadata = null;
    
    if (isReply(event)) {
      const replyToId = getReplyToEventId(event);
      console.log(`Detected reply to event ${replyToId?.slice(0, 8) || 'unknown'}`);
      
      if (replyToId) {
        originalEvent = await fetchOriginalEvent(replyToId);
        
        if (originalEvent && originalEvent.pubkey) {
          originalAuthorMetadata = userMetadataCache[originalEvent.pubkey];
          if (!originalAuthorMetadata) {
            originalAuthorMetadata = await fetchUserMetadata(originalEvent.pubkey);
            if (originalAuthorMetadata) {
              userMetadataCache[originalEvent.pubkey] = originalAuthorMetadata;
            }
          }
        }
      }
    }
    
    // Format the event for Discord
    const discordMessage = formatForDiscord(event, userMetadata, originalEvent, originalAuthorMetadata);
    
    // Send to Discord
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(discordMessage),
    });
    
    if (response.ok) {
      // Mark as processed
      processedEvents.add(event.id);
      lastProcessedTime = Date.now();
      
      // Limit cache size
      if (processedEvents.size > 200) {
        const iterator = processedEvents.values();
        processedEvents.delete(iterator.next().value);
      }
      
      return {
        success: true,
        message: `${isReply(event) ? 'Reply' : 'Event'} ${event.id.slice(0, 8)}... forwarded to Discord successfully`
      };
    } else {
      return {
        success: false,
        error: `Discord API error: ${response.status} ${response.statusText}`
      };
    }
  } catch (error) {
    return {
      success: false,
      error: error.message || "Unknown error"
    };
  }
}

// Format Nostr content for Discord with reply support
function formatForDiscord(event, userMetadata, originalEvent = null, originalAuthor = null) {
  const noteId = nip19.noteEncode(event.id);
  const timestamp = new Date(event.created_at * 1000).toISOString();
  
  // Determine user info
  const username = userMetadata?.name || userMetadata?.display_name || "Nostr User";
  const avatarUrl = userMetadata?.picture || "https://nostr.com/img/nostr-logo.png";
  
  // Get preferred client links
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
      text: `Nostr Event ID: ${event.id.slice(0, 8)}...`
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

// Fetch user metadata from Nostr
async function fetchUserMetadata(pubkey) {
  if (!pubkey) return null;
  
  try {
    const relayUrls = (process.env.NOSTR_RELAYS || 'wss://relay.damus.io,wss://relay.nostr.band').split(',');
    const pool = new SimplePool({ eoseSubTimeout: 3000 });
    
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
    console.error("Error fetching metadata:", error);
    return null;
  }
}
