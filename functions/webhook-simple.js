const serverless = require('serverless-http');
const express = require('express');
const dotenv = require('dotenv');
dotenv.config();

// A simplified version of the webhook handler for Netlify deployment
// to avoid transpilation issues

const app = express();
app.use(express.json());

// Endpoint to verify the webhook is functioning
app.get('/.netlify/functions/webhook-simple', (req, res) => {
  res.json({
    status: 'active',
    message: 'Nostr2Discord bot is running. Use POST to update configuration.'
  });
});

// Endpoint to update webhook configuration
app.post('/.netlify/functions/webhook-simple', (req, res) => {
  const secret = req.headers && req.headers.secret;
  const configSecret = process.env.CONFIG_SECRET;
  
  // Validate secret
  if (!secret || secret !== configSecret) {
    return res.status(401).json({ error: 'Unauthorized: Invalid secret' });
  }
  
  const requestBody = req.body || {};
  const nostrPubkey = requestBody.nostrPubkey;
  const discordWebhook = requestBody.discordWebhook;
  const relays = requestBody.relays;
  
  // Validate required params
  if (!nostrPubkey || !discordWebhook) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }
  
  // Since we can't dynamically update the running bot from a serverless function,
  // we'll just return confirmation that the request was valid
  try {
    return res.json({ 
      status: 'success', 
      message: 'Configuration request received',
      config: {
        pubkey: nostrPubkey,
        webhook: discordWebhook,
        relays: relays ? relays.split(',') : []
      }
    });
  } catch (error) {
    const errorMessage = error && typeof error.message === 'string' ? error.message : 'Unknown error';
    return res.status(500).json({ 
      error: 'Failed to process configuration', 
      details: errorMessage
    });
  }
});

// Export the serverless function
module.exports.handler = serverless(app);
