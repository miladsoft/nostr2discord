require('dotenv').config();
const fetch = require('node-fetch');

// This is a diagnostic function to test the Discord webhook connection

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
  
  // Handle GET requests - show debug options
  if (event.httpMethod === 'GET') {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        status: "active",
        message: "Debug webhook is active. Use POST with action parameter to test.",
        actions: {
          test_discord: "Test Discord webhook connectivity",
          test_relay: "Test Nostr relay connectivity",
          check_config: "Show current configuration"
        }
      })
    };
  }
  
  // Handle POST requests - perform requested debug action
  if (event.httpMethod === 'POST') {
    try {
      // Parse the request body or use query parameters
      let action = '';
      let webhookUrl = process.env.DISCORD_WEBHOOK_URL;
      let customMessage = '';
      
      if (event.body) {
        const body = JSON.parse(event.body);
        action = body.action || '';
        webhookUrl = body.webhookUrl || webhookUrl;
        customMessage = body.message || '';
      }
      
      // Get action from query params if not in body
      if (!action && event.queryStringParameters) {
        action = event.queryStringParameters.action || '';
      }
      
      // Handle different debug actions
      if (action === 'test_discord') {
        return await testDiscordWebhook(headers, webhookUrl, customMessage);
      }
      else if (action === 'check_config') {
        return await checkConfiguration(headers);
      }
      else {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: "Invalid action. Valid actions are: test_discord, test_relay, check_config"
          })
        };
      }
    } catch (error) {
      console.error("Error in debug webhook:", error);
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

// Test Discord webhook connection
async function testDiscordWebhook(headers, webhookUrl, customMessage) {
  if (!webhookUrl) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: "No Discord webhook URL provided"
      })
    };
  }
  
  try {
    // Create a simple test message
    const testMessage = {
      username: "Discord Bot Test",
      avatar_url: "https://cdn.discordapp.com/embed/avatars/0.png",
      content: customMessage || `🔍 This is a test message from Nostr2Discord debug webhook. Timestamp: ${new Date().toISOString()}`,
      embeds: [{
        title: "Discord Webhook Test",
        description: "If you can see this message, your Discord webhook is working correctly!",
        color: 5814783, // Light blue color
        footer: {
          text: "Sent from Nostr2Discord Debug Function"
        }
      }]
    };
    
    console.log(`Sending test message to Discord webhook: ${webhookUrl.substring(0, 30)}...`);
    
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(testMessage),
    });
    
    let responseText;
    try {
      responseText = await response.text();
    } catch (e) {
      responseText = "(Could not read response body)";
    }
    
    if (response.ok) {
      console.log("Discord test message sent successfully!");
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          message: "Discord test message sent successfully!",
          response: {
            status: response.status,
            statusText: response.statusText,
            body: responseText
          }
        })
      };
    } else {
      console.error(`Failed to send Discord test message: ${response.status} ${response.statusText}`);
      console.error(`Response body: ${responseText}`);
      return {
        statusCode: response.status,
        headers,
        body: JSON.stringify({
          success: false,
          error: `Discord API Error: ${response.status} ${response.statusText}`,
          response: {
            status: response.status,
            statusText: response.statusText,
            body: responseText
          }
        })
      };
    }
  } catch (error) {
    console.error("Error sending test message:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: error.message || "Unknown error"
      })
    };
  }
}

// Check and display configuration
async function checkConfiguration(headers) {
  // Get environment variables, masking sensitive parts
  const config = {
    NOSTR_RELAYS: process.env.NOSTR_RELAYS ? process.env.NOSTR_RELAYS.split(',') : [],
    NOSTR_PUBKEY: maskString(process.env.NOSTR_PUBKEY),
    DISCORD_WEBHOOK_URL: maskString(process.env.DISCORD_WEBHOOK_URL),
    PREFERRED_CLIENT: process.env.PREFERRED_CLIENT || 'all',
    CHECK_INTERVAL_MS: process.env.CHECK_INTERVAL_MS || '30000',
    DEBUG: process.env.DEBUG === 'true'
  };
  
  // Check for missing required configuration
  const missingConfig = [];
  if (!process.env.NOSTR_PUBKEY) missingConfig.push('NOSTR_PUBKEY');
  if (!process.env.DISCORD_WEBHOOK_URL) missingConfig.push('DISCORD_WEBHOOK_URL');
  if (!process.env.NOSTR_RELAYS) missingConfig.push('NOSTR_RELAYS');
  
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      config: config,
      missingRequiredConfig: missingConfig.length > 0 ? missingConfig : null,
      environment: process.env.NODE_ENV || 'development',
      deploymentInfo: {
        functionName: context?.functionName || 'debug-webhook',
        region: process.env.AWS_REGION || 'unknown',
        netlifyContext: process.env.CONTEXT || 'unknown'
      }
    })
  };
}

// Helper to mask sensitive strings like tokens for output
function maskString(str) {
  if (!str) return null;
  if (str.length <= 8) return '***';
  return `${str.substring(0, 4)}...${str.substring(str.length - 4)}`;
}
