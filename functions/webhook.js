const serverless = require('serverless-http');
const express = require('express');
const { subscribeToNostrEvents } = require('../index');

const app = express();
app.use(express.json());

// Endpoint to verify the webhook is functioning
app.get('/.netlify/functions/webhook', (req, res) => {
  res.json({
    status: 'active',
    message: 'Nostr2Discord bot is running. Use POST to update configuration.'
  });
});

// Endpoint to update webhook configuration
app.post('/.netlify/functions/webhook', (req, res) => {
  const { secret } = req.headers;
  const configSecret = process.env.CONFIG_SECRET;
  
  // Validate secret
  if (!secret || secret !== configSecret) {
    return res.status(401).json({ error: 'Unauthorized: Invalid secret' });
  }
  
  const { nostrPubkey, discordWebhook, relays } = req.body;
  
  // Validate required params
  if (!nostrPubkey || !discordWebhook) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }
  
  // Set environment variables (in memory for this session)
  process.env.NOSTR_PUBKEY = nostrPubkey;
  process.env.DISCORD_WEBHOOK_URL = discordWebhook;
  
  if (relays) {
    process.env.NOSTR_RELAYS = relays;
  }
  
  // Restart subscription with new config
  try {
    subscribeToNostrEvents();
    return res.json({ 
      status: 'success', 
      message: 'Configuration updated successfully',
      config: {
        pubkey: nostrPubkey,
        relays: process.env.NOSTR_RELAYS.split(',')
      }
    });
  } catch (error) {
    return res.status(500).json({ 
      error: 'Failed to update configuration', 
      details: error.message 
    });
  }
});

// Export the serverless function
module.exports.handler = serverless(app);
