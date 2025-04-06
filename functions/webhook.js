require('dotenv').config();
require('websocket-polyfill');
const { SimplePool, nip19, getEventHash, validateEvent, verifySignature } = require('nostr-tools');
const fetch = require('node-fetch');

// In-memory cache for processed events (not persistent between function invocations)
const processedEvents = new Set();
let userMetadataCache = {};

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
        processedEvents: processedEvents.size
      })
    };
  }
  
  // Handle POST requests (Nostr events or configuration)
  if (event.httpMethod === 'POST') {
    try {
      const payload = JSON.parse(event.body);
      
      // Check if this is a Nostr event
      if (payload.id && payload.pubkey && payload.sig) {
        return await handleNostrEvent(payload, headers);
      } 
      // Check if this is a configuration update
      else if (payload.nostrPubkey || payload.discordWebhook) {
        return handleConfigUpdate(payload, headers);
      } 
      // Unknown payload
      else {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ 
            success: false, 
            error: "Invalid payload structure" 
          })
        };
      }
    } catch (error) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ 
          success: false, 
          error: error.message || "Internal server error" 
        })
      };
    }
  }
  
  // Unsupported method
  return {
    statusCode: 405,
    headers,
    body: JSON.stringify({ 
      success: false, 
      error: "Method not allowed" 
    })
  };
};

// Handle incoming Nostr events
async function handleNostrEvent(event, headers) {
  // Check if we've already processed this event
  if (processedEvents.has(event.id)) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        success: true,
        status: "already_processed" 
      })
    };
  }
  
  // Validate event structure and signature
  try {
    if (!validateEvent(event) || !verifySignature(event)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ 
          success: false, 
          error: "Invalid event signature or structure" 
        })
      };
    }
  } catch (error) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ 
        success: false, 
        error: "Event validation error: " + (error.message || "unknown error") 
      })
    };
  }
  
  // Only process text notes (kind 1)
  if (event.kind !== 1) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        success: true,
        status: "ignored_non_text_event",
        kind: event.kind
      })
    };
  }
  
  // Get Discord webhook URL from environment
  const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!discordWebhookUrl) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        success: false, 
        error: "Discord webhook URL not configured" 
      })
    };
  }
  
  try {
    // Get user metadata if we don't already have it cached
    if (!userMetadataCache[event.pubkey]) {
      userMetadataCache[event.pubkey] = await fetchUserMetadata(event.pubkey);
    }
    
    // Format for Discord
    const discordPayload = formatForDiscord(event, userMetadataCache[event.pubkey]);
    
    // Send to Discord
    const response = await fetch(discordWebhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(discordPayload),
    });
    
    if (!response.ok) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ 
          success: false, 
          error: `Discord API error: ${response.status} ${response.statusText}` 
        })
      };
    }
    
    // Mark event as processed
    processedEvents.add(event.id);
    
    // Prevent memory leaks by limiting the size of the set
    if (processedEvents.size > 100) {
      const firstItem = processedEvents.values().next().value;
      processedEvents.delete(firstItem);
    }
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        success: true, 
        status: "forwarded_to_discord" 
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        success: false, 
        error: `Error processing event: ${error.message || "Unknown error"}` 
      })
    };
  }
}

// Handle configuration updates
function handleConfigUpdate(payload, headers) {
  // Update configuration logic would go here
  // For security, this should be protected with a secret token
  
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ 
      success: true,
      message: "Configuration updated" 
    })
  };
}

// Format Nostr content for Discord
function formatForDiscord(event, userMetadata) {
  // Get the username and avatar from metadata if available
  const username = userMetadata?.name || userMetadata?.display_name || "Nostr User";
  const avatarUrl = userMetadata?.picture || "https://nostr.com/img/nostr-logo.png";
  
  // Get client links based on configuration
  const viewerLinks = getViewerLinks(event.id);
  
  // Format as embed message
  const timestamp = new Date(event.created_at * 1000).toISOString();
  
  // Create Discord embed
  const embed = {
    description: event.content,
    color: 3447003, // Blue color
    timestamp: timestamp,
    footer: {
      text: `View post in Nostr clients`
    },
    fields: [
      {
        name: "Links",
        value: viewerLinks.linksText
      }
    ]
  };
  
  // Send original content as embed
  const message = {
    username: username,
    avatar_url: avatarUrl,
    embeds: [embed]
  };
  
  return message;
}

// Get viewer links based on configuration
function getViewerLinks(eventId) {
  const noteId = nip19.noteEncode(eventId);
  
  // Get preferred client from env var (primal, notes, njump, or all)
  const preferredClient = process.env.PREFERRED_CLIENT || 'all';
  
  // Build links based on preference
  const primalLink = `https://primal.net/e/${noteId}`;
  const notesLink = `https://notes.blockcore.net/e/${eventId}`;
  const njumpLink = `https://njump.me/${noteId}`;
  
  let linksText = '';
  let preferredLink = '';
  
  if (preferredClient === 'primal') {
    linksText = `🔗 View on Primal: ${primalLink}`;
    preferredLink = primalLink;
  } 
  else if (preferredClient === 'notes') {
    linksText = `🔗 View on Blockcore Notes: ${notesLink}`;
    preferredLink = notesLink;
  }
  else if (preferredClient === 'njump') {
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

// Fetch user metadata from Nostr
async function fetchUserMetadata(pubkey) {
  if (!pubkey) return null;
  
  const relayUrls = (process.env.NOSTR_RELAYS || 'wss://relay.damus.io,wss://relay.nostr.info').split(',');
  
  try {
    const pool = new SimplePool({ eoseSubTimeout: 5000 }); // 5 second timeout
    
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
      }, 5000);
      
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
        // Keep waiting for a bit in case metadata comes in late
      });
    });
  } catch (error) {
    console.error("Error fetching user metadata:", error);
    return null;
  }
}
