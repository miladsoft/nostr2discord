require('dotenv').config();
const fetch = require('node-fetch');

// Simple utility to check Netlify function logs directly
// Run this script with 'node logs.js' to see recent function logs

async function checkFunctionLogs() {
  console.log("Checking Netlify function logs...");
  
  try {
    // First test the Discord webhook directly
    await testDiscordWebhook();
    
    // Then manually trigger the scheduled poller
    await triggerPoller();
    
  } catch (err) {
    console.error("Error checking function logs:", err);
  }
}

async function testDiscordWebhook() {
  console.log("\n=== Testing Discord Webhook ===");
  
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  
  if (!webhookUrl) {
    console.error("No webhook URL configured in .env file");
    return;
  }
  
  try {
    console.log(`Sending test message to webhook: ${webhookUrl.slice(0, 30)}...`);
    
    const testMessage = {
      content: "This is a test message from the logs.js utility script.",
      username: "Nostr2Discord Test",
      avatar_url: "https://cdn.discordapp.com/embed/avatars/0.png"
    };
    
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(testMessage),
    });
    
    if (response.ok) {
      console.log("✅ Test message sent successfully!");
    } else {
      console.error(`❌ Error ${response.status}: ${response.statusText}`);
      const text = await response.text();
      console.error("Response:", text);
    }
  } catch (error) {
    console.error("❌ Failed to send test message:", error.message);
  }
}

async function triggerPoller() {
  console.log("\n=== Triggering Scheduled Poller ===");
  
  // If netlify site URL is configured, use it, otherwise use localhost for dev
  const baseUrl = process.env.URL || "http://localhost:8888";
  const url = `${baseUrl}/.netlify/functions/scheduled-poller`;
  
  try {
    console.log(`Triggering poller at: ${url}`);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ manual: true }),
    });
    
    const result = await response.json();
    
    if (response.ok) {
      console.log("✅ Poller triggered successfully!");
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`❌ Error ${response.status}: ${response.statusText}`);
      console.error("Response:", JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error("❌ Failed to trigger poller:", error.message);
  }
}

checkFunctionLogs();
