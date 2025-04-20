# Nostr2Discord Bot

This bot forwards text posts (kind 1 events) from a Nostr account to a Discord channel via webhooks.

## Features

- Monitors a specified Nostr public key for new posts
- Forwards posts to Discord via webhook as beautiful embeds
- Posts are sent exactly as they appear in Nostr, with no content modifications
- Supports multiple Nostr relays for reliable delivery
- Discord automatically renders any media links in the posts
- Uses the Nostr user's profile picture and name for Discord messages
- Provides links to view posts on Nostr clients (Primal, Blockcore Notes, nostr_at)
- Configurable display options

## Configuration

In your `.env` file:

```env
# Choose which Nostr client link(s) to include in posts
# Options: "primal", "notes", "nostr_at", "all"
PREFERRED_CLIENT=all
```

## Message Format

Posts are sent as Discord embeds:
- Original post content is preserved in the embed description
- Discord automatically renders any media links in the embed
- Nostr client links are added in the embed fields
- Messages appear with the Nostr user's profile picture and name
- Timestamp is included in the embed

## Nostr Clients

The bot can generate links to different Nostr web clients:

- **Primal**: Modern Nostr client with advanced features
- **Blockcore Notes**: Clean and simple Nostr client
- **nostr_at**: Universal Nostr content viewer

## Setup

1. Create a Discord webhook in your server's channel settings
2. Set your Nostr public key in the `.env` file (hex or npub format)
3. Configure any display preferences in the `.env` file
4. Run the bot with `npm start`

