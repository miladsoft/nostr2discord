require('dotenv').config();
const { nip19 } = require('nostr-tools');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Function to convert between npub and hex
function convertNostrKey() {
  console.log("=== NOSTR PUBLIC KEY CONVERTER ===");
  
  // Try to get key from env file
  const envPubkey = process.env.NOSTR_PUBKEY;
  
  if (envPubkey) {
    console.log(`Found public key in .env file: ${envPubkey}`);
    processKey(envPubkey);
  } else {
    rl.question('Enter your Nostr public key (hex or npub format): ', (answer) => {
      processKey(answer);
      rl.close();
    });
  }
}

// Process and convert a key
function processKey(key) {
  try {
    if (key.startsWith('npub')) {
      // Convert npub to hex
      const decoded = nip19.decode(key);
      console.log(`\n✅ Successfully decoded npub`);
      console.log(`\nHex format: ${decoded.data}`);
      console.log(`\nUpdate your .env file with:`);
      console.log(`NOSTR_PUBKEY=${decoded.data}`);
    } else {
      // Convert hex to npub
      const encoded = nip19.npubEncode(key);
      console.log(`\nHex key: ${key}`);
      console.log(`npub format: ${encoded}`);
      
      // Verify by decoding back
      const decoded = nip19.decode(encoded);
      if (decoded.data === key) {
        console.log(`\n✅ Key validation successful`);
      } else {
        console.log(`\n❌ Key validation error - decoded value doesn't match original`);
      }
    }
  } catch (error) {
    console.error(`\n❌ Error processing key: ${error.message}`);
    console.log('Make sure the key is in valid hex or npub format');
  }
}

// Run the converter
convertNostrKey();
