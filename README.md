# Nostr2Discord Bot

Forwards Nostr posts to Discord automatically.

## Quick Setup

1. **Create config file:**
```bash
cp .env.example .env
```

2. **Configure settings:**
```env
NOSTR_PUBKEY=your_npub_or_hex_pubkey
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

3. **Run:**
```bash
docker-compose up -d
```

4. **View logs:**
```bash
docker-compose logs -f nostr2discord
```

## Stop

```bash
docker-compose down
```

## Environment Settings

```env
# Nostr public key (npub or hex format)
NOSTR_PUBKEY=npub1...

# Discord webhook URL
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...

# Nostr relays (optional)
NOSTR_RELAYS=wss://relay.damus.io,wss://relay.primal.net

# Additional settings
CHECK_INTERVAL_MS=30000
DEBUG=false
```

Every new Nostr post is instantly sent to Discord!

