# Nostr2Discord Bot

This bot forwards text posts (kind 1 events) from a Nostr account to a Discord channel via webhooks.

## Features

- Monitors a specified Nostr public key for new posts
- Forwards posts to Discord via webhook
- Supports multiple Nostr relays for reliable delivery
- Displays post content with embedded media
- Provides links to view posts on Nostr clients (Primal, Blockcore Notes, njump)
- Configurable display options

## Configuration

In your `.env` file:

```env
# Choose which Nostr client link(s) to include in posts
# Options: "primal", "notes", "njump", "all"
PREFERRED_CLIENT=all
```

## Nostr Clients

The bot can generate links to different Nostr web clients:

- **Primal**: Modern Nostr client with advanced features
- **Blockcore Notes**: Clean and simple Nostr client
- **njump**: Universal Nostr content viewer

## Setup

1. Create a Discord webhook in your server's channel settings
2. Set your Nostr public key in the `.env` file (hex or npub format)
3. Run the bot with `npm start`

