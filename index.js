require('dotenv').config();
require('websocket-polyfill');
const { relayInit, nip19, SimplePool, getEventHash, validateEvent, verifySignature } = require('nostr-tools');
const fetch = require('node-fetch');

// Default relays
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

// Configuration from environment variables
const relayUrls = (process.env.NOSTR_RELAYS || DEFAULT_RELAYS).split(',');
let pubkey = process.env.NOSTR_PUBKEY;
const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
const checkIntervalMs = parseInt(process.env.CHECK_INTERVAL_MS || '30000');
const debug = process.env.DEBUG === 'true';
const monitoredEventKinds = (process.env.MONITORED_EVENT_KINDS || '1').split(',').map(k => parseInt(k.trim()));

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
console.log(`Monitoring event kinds: ${monitoredEventKinds.join(', ')} (1=text, 7=reaction, 9735=zap, 6=repost)`);
console.log(`Debug mode: ${debug ? 'ON' : 'OFF'}`);

// Initialize a relay pool with longer timeout
const pool = new SimplePool({ eoseSubTimeout: 10000 }); // Increase EOSE timeout to 10s

// Store for processed events to prevent duplicates
const processedEvents = new Set();

// Store user metadata including profile picture
let userMetadata = null;

// Debug logging function
function logDebug(message) {
  if (debug) {
    console.log(`[DEBUG] ${message}`);
  }
}

// Fetch user profile metadata from Nostr
async function fetchUserMetadata() {
  if (!pubkey) return null;
  
  console.log(`🔍 Fetching profile metadata for pubkey: ${pubkey}`);
  
  try {
    // Create a subscription for kind 0 (metadata) events
    const metadataSub = pool.sub(relayUrls, [{
      kinds: [0],
      authors: [pubkey],
    }]);
    
    return new Promise((resolve) => {
      let timeout = setTimeout(() => {
        console.log("⏱️ Metadata fetch timed out, using default avatar");
        metadataSub.unsub();
        resolve(null);
      }, 10000);
      
      metadataSub.on('event', event => {
        try {
          clearTimeout(timeout);
          const metadata = JSON.parse(event.content);
          console.log("✅ Found user metadata:", metadata?.name || "unnamed user");
          metadataSub.unsub();
          resolve(metadata);
        } catch (e) {
          console.error("❌ Error parsing user metadata:", e);
          resolve(null);
        }
      });
      
      metadataSub.on('eose', () => {
        // Keep waiting for a bit in case metadata comes in late
      });
    });
  } catch (error) {
    console.error("❌ Error fetching user metadata:", error);
    return null;
  }
}

// Format different event types for Discord
function formatEventForDiscord(event) {
  switch (event.kind) {
    case 1:
      return formatTextNote(event);
    case 7:
      return formatReaction(event);
    case 9735:
      return formatZap(event);
    case 6:
      return formatRepost(event);
    default:
      return formatGenericEvent(event);
  }
}

// Format text note (kind 1)
function formatTextNote(event) {
  const content = event.content;
  const viewerLinks = getViewerLinks(event.id);
  const timestamp = new Date(event.created_at * 1000).toISOString();
  
  // Check if this is your post or someone replying to you
  const isYourPost = event.pubkey === pubkey;
  const isReplyToYou = !isYourPost && event.tags.some(tag => tag[0] === 'p' && tag[1] === pubkey);
  
  let username, avatarUrl, footerText, embedColor;
  
  if (isYourPost) {
    // Your post
    username = userMetadata?.name || userMetadata?.display_name || "Nostr User";
    avatarUrl = userMetadata?.picture || "https://nostr.com/img/nostr-logo.png";
    footerText = "📝 New Post";
    embedColor = 3447003; // Blue
  } else if (isReplyToYou) {
    // Someone replied to you
    username = "Reply Notification";
    avatarUrl = "https://nostr.com/img/nostr-logo.png";
    footerText = "💬 New Reply to Your Post";
    embedColor = 65280; // Green
  } else {
    // Fallback (shouldn't happen with current filters)
    username = "Nostr User";
    avatarUrl = "https://nostr.com/img/nostr-logo.png";
    footerText = "📝 Text Note";
    embedColor = 3447003; // Blue
  }

  const embed = {
    description: isReplyToYou ? `💬 **Reply:** ${content}` : content,
    color: embedColor,
    timestamp: timestamp,
    footer: { text: footerText },
    fields: [{ name: "Links", value: viewerLinks.linksText }]
  };

  return {
    username: username,
    avatar_url: avatarUrl,
    embeds: [embed]
  };
}

// Format reaction (kind 7)
function formatReaction(event) {
  const content = event.content || "👍";
  const timestamp = new Date(event.created_at * 1000).toISOString();

  // Get reactor's info (who made the reaction)
  const reactorPubkey = event.pubkey;
  const reactorNpub = nip19.npubEncode(reactorPubkey);
  
  // Try to find the post being reacted to
  let reactedToPost = "your post";
  const eTags = event.tags.filter(tag => tag[0] === 'e');
  if (eTags.length > 0) {
    const eventId = eTags[0][1];
    const noteId = nip19.noteEncode(eventId);
    let neventId;
    try {
      neventId = nip19.neventEncode({
        id: eventId,
        relays: ['wss://relay.damus.io', 'wss://relay.primal.net']
      });
      reactedToPost = `[your post](https://nostria.app/e/${neventId})`;
    } catch (error) {
      reactedToPost = `[your post](https://nostria.app/e/${noteId})`;
    }
  }

  const embed = {
    description: `**${reactorNpub}** reacted with **${content}** to ${reactedToPost}`,
    color: 16776960, // Yellow
    timestamp: timestamp,
    footer: { text: "⚡ New Reaction" }
  };

  return {
    username: "Reaction Notification",
    avatar_url: "https://nostr.com/img/nostr-logo.png",
    embeds: [embed]
  };
}

// Format zap (kind 9735)
function formatZap(event) {
  const timestamp = new Date(event.created_at * 1000).toISOString();
  const username = userMetadata?.name || userMetadata?.display_name || "Nostr User";
  const avatarUrl = userMetadata?.picture || "https://nostr.com/img/nostr-logo.png";

  // Extract zap amount and sender/recipient info
  let zapAmount = "Unknown amount";
  let zapSender = "Anonymous";
  let zapNote = "";
  let zapSenderAvatar = "https://nostr.com/img/nostr-logo.png";

  try {
    // First try to get amount from zap request (most reliable)
    const zapRequestTag = event.tags.find(tag => tag[0] === 'description');
    if (zapRequestTag && zapRequestTag[1]) {
      try {
        const zapRequest = JSON.parse(zapRequestTag[1]);
        
        // Look for amount tag in zap request
        if (zapRequest.tags) {
          const amountTag = zapRequest.tags.find(tag => tag[0] === 'amount');
          if (amountTag && amountTag[1]) {
            const millisats = parseInt(amountTag[1]);
            const sats = Math.floor(millisats / 1000);
            zapAmount = `${sats} sats`;
          }
        }
      } catch (e) {
        console.log("Could not parse zap request for amount");
      }
    }

    // Fallback: Parse bolt11 invoice if amount not found in zap request
    if (zapAmount === "Unknown amount") {
      const bolt11Tag = event.tags.find(tag => tag[0] === 'bolt11');
      if (bolt11Tag && bolt11Tag[1]) {
        const invoice = bolt11Tag[1];
        
        // Better bolt11 parsing - look for amount in millisatoshis
        const amountMatch = invoice.match(/lnbc(\d+)([munp]?)/);
        if (amountMatch) {
          let amount = parseInt(amountMatch[1]);
          const unit = amountMatch[2] || '';
          
          // Convert to millisatoshis based on unit
          switch(unit) {
            case 'm': amount = amount * 100000000; break; // mBTC
            case 'u': amount = amount * 100000; break;    // μBTC  
            case 'n': amount = amount * 100; break;       // nBTC
            case 'p': amount = amount * 0.1; break;       // pBTC
            default: amount = amount; break;              // millisats
          }
          
          const sats = Math.floor(amount / 1000);
          if (sats > 0) {
            zapAmount = `${sats} sats`;
          }
        }
      }
    }

    // Parse zap request for sender info and note (if not already parsed above)
    if (zapRequestTag && zapRequestTag[1]) {
      try {
        const zapRequest = JSON.parse(zapRequestTag[1]);
        zapNote = zapRequest.content || "";
        
        // Get sender pubkey from zap request
        if (zapRequest.pubkey) {
          zapSender = nip19.npubEncode(zapRequest.pubkey);
        }
      } catch (e) {
        console.error("Error parsing zap request for sender info:", e);
      }
    }
  } catch (error) {
    console.error("Error parsing zap event:", error);
  }

  const embed = {
    description: `⚡ **${zapAmount}** received from ${zapSender}${zapNote ? `\n\n💬 "${zapNote}"` : ''}`,
    color: 16753920, // Orange
    timestamp: timestamp,
    footer: { text: "⚡ Zap Sent" }
  };

  return {
    username: username,
    avatar_url: avatarUrl,
    embeds: [embed]
  };
}

// Format repost (kind 6)
function formatRepost(event) {
  const timestamp = new Date(event.created_at * 1000).toISOString();
  
  // Get reposter's info
  const reposterPubkey = event.pubkey;
  const reposterNpub = nip19.npubEncode(reposterPubkey);
  
  let repostedContent = "your post";
  const eTags = event.tags.filter(tag => tag[0] === 'e');
  if (eTags.length > 0) {
    const eventId = eTags[0][1];
    const noteId = nip19.noteEncode(eventId);
    let neventId;
    try {
      neventId = nip19.neventEncode({
        id: eventId,
        relays: ['wss://relay.damus.io', 'wss://relay.primal.net']
      });
      repostedContent = `[your post](https://nostria.app/e/${neventId})`;
    } catch (error) {
      repostedContent = `[your post](https://nostria.app/e/${noteId})`;
    }
  }

  const embed = {
    description: `🔄 **${reposterNpub}** reposted ${repostedContent}`,
    color: 3066993, // Green
    timestamp: timestamp,
    footer: { text: "🔄 New Repost" }
  };

  return {
    username: "Repost Notification",
    avatar_url: "https://nostr.com/img/nostr-logo.png",
    embeds: [embed]
  };
}

// Format generic event
function formatGenericEvent(event) {
  const timestamp = new Date(event.created_at * 1000).toISOString();
  const username = userMetadata?.name || userMetadata?.display_name || "Nostr User";
  const avatarUrl = userMetadata?.picture || "https://nostr.com/img/nostr-logo.png";

  const embed = {
    description: `Event kind ${event.kind}: ${event.content?.substring(0, 200) || 'No content'}`,
    color: 9936031, // Purple
    timestamp: timestamp,
    footer: { text: `📊 Event Kind ${event.kind}` }
  };

  return {
    username: username,
    avatar_url: avatarUrl,
    embeds: [embed]
  };
}

// Legacy function for backward compatibility  
function formatForDiscord(event) {
  return formatEventForDiscord(event);
}

// Get viewer links based on configuration
function getViewerLinks(eventId) {
  const noteId = nip19.noteEncode(eventId);
  
  // Create nevent for Nostria (includes event id + relays for better compatibility)
  let neventId;
  try {
    neventId = nip19.neventEncode({
      id: eventId,
      relays: ['wss://relay.damus.io', 'wss://relay.primal.net']
    });
  } catch (error) {
    console.error('Error creating nevent:', error);
    neventId = noteId; // fallback to note format
  }
  
  // Get preferred client from env var (nostria, yakihonne, or all)
  const preferredClient = process.env.PREFERRED_CLIENT || 'all';
  
  // Build links based on preference
  const nostriaLink = `https://nostria.app/e/${neventId}`;
  const yakihonneLink = `https://yakihonne.com/article/${noteId}`;
  
  let linksText = '';
  let preferredLink = '';
  
  if (preferredClient === 'nostria') {
    linksText = `🔗 View on Nostria: ${nostriaLink}`;
    preferredLink = nostriaLink;
  } 
  else if (preferredClient === 'yakihonne') {
    linksText = `🔗 View on YakiHonne: ${yakihonneLink}`;
    preferredLink = yakihonneLink;
  }
  else {
    // Default to showing all - Nostria first as requested
    linksText = `🔗 View on: [Nostria](${nostriaLink}) | [YakiHonne](${yakihonneLink})`;
    preferredLink = nostriaLink;
  }
  
  return { linksText, preferredLink };
}

// Send event to Discord webhook
async function sendToDiscord(event) {
  try {
    if (processedEvents.has(event.id)) {
      console.log(`Event ${event.id.slice(0, 8)}... already processed, skipping`);
      return;
    }
    
    const discordMessage = formatForDiscord(event);
    
    // Add a small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 2000));
    
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

// Remove optional chaining from any functions that might be used in Netlify functions
// Safely insert an event into an array in sorted order without optional chaining
function insertSorted(sortedArray, event, compare) {
  let position = sortedArray.findIndex(e => compare(event, e) < 0);
  
  if (position === -1) {
    position = sortedArray.length;
  }
  
  // Check if there's an element at the position and if it has the same ID
  if (position < sortedArray.length && sortedArray[position] && sortedArray[position].id === event.id) {
    return sortedArray; // Event already exists
  }
  
  return [
    ...sortedArray.slice(0, position), 
    event, 
    ...sortedArray.slice(position)
  ];
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
  
  // Fetch user metadata for profile picture and name
  userMetadata = await fetchUserMetadata();
  
  logDebug("Setting up subscription filter");
  
  // Subscribe to configured event types
  const filters = [];
  const sinceTime = Math.floor(Date.now() / 1000);
  
  // 1. Text notes FROM your pubkey (your posts)
  if (monitoredEventKinds.includes(1)) {
    filters.push({
      authors: [pubkey],
      kinds: [1],
      since: sinceTime
    });
  }
  
  // 2. Replies TO your posts (kind 1 with #p tag mentioning you)
  if (monitoredEventKinds.includes(1)) {
    filters.push({
      kinds: [1],
      "#p": [pubkey],
      since: sinceTime
    });
  }
  
  // 3. Reactions TO your posts (kind 7 with #p tag)
  if (monitoredEventKinds.includes(7)) {
    filters.push({
      kinds: [7],
      "#p": [pubkey],
      since: sinceTime
    });
  }
  
  // 4. Reposts OF your posts (kind 6 with #p tag)
  if (monitoredEventKinds.includes(6)) {
    filters.push({
      kinds: [6],
      "#p": [pubkey],
      since: sinceTime
    });
  }
  
  // 5. Zaps sent TO you (kind 9735 with #p tag)
  if (monitoredEventKinds.includes(9735)) {
    filters.push({
      kinds: [9735],
      "#p": [pubkey],
      since: sinceTime
    });
  }
  
  logDebug(`Subscription filters: ${JSON.stringify(filters)}`);
  
  const sub = pool.sub(relayUrls, filters);
  
  console.log("Waiting for new events...");
  
  let receivedEventCount = 0;
  
  sub.on('event', event => {
    receivedEventCount++;
    console.log(`📥 Received event ${receivedEventCount} (kind ${event.kind}): ${event.id}`);
    
    // Log event type and content
    const eventTypeNames = {
      1: 'Text Note',
      7: 'Reaction', 
      9735: 'Zap',
      6: 'Repost'
    };
    const eventTypeName = eventTypeNames[event.kind] || `Unknown (${event.kind})`;
    console.log(`📝 Event Type: ${eventTypeName}`);
    console.log(`📝 Content: ${event.content?.substring(0, 100) || 'No content'}${event.content?.length > 100 ? '...' : ''}`);
    
    // Log links to different clients
    const noteId = nip19.noteEncode(event.id);
    let neventId;
    try {
      neventId = nip19.neventEncode({
        id: event.id,
        relays: ['wss://relay.damus.io', 'wss://relay.primal.net']
      });
    } catch (error) {
      console.error('Error creating nevent for logs:', error);
      neventId = noteId; // fallback
    }
    console.log(`🔗 Nostria Link: https://nostria.app/e/${neventId}`);
    console.log(`🔗 YakiHonne Link: https://yakihonne.com/article/${noteId}`);
    
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
  console.error("Error during subscription:", error && error.message ? error.message : 'Unknown error');
});

// Keep the process alive
setInterval(() => {
  console.log('💓 Heartbeat check... Bot is running');
}, checkIntervalMs);

// Export for serverless functions
module.exports = { subscribeToNostrEvents, sendToDiscord, insertSorted };
