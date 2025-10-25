#!/bin/bash

# Build and test the Docker container

echo "🔨 Building Docker image..."
docker build -t nostr2discord .

if [ $? -eq 0 ]; then
    echo "✅ Docker image built successfully!"
    echo "🚀 You can now run the bot with:"
    echo "   docker-compose up -d"
    echo ""
    echo "📋 Make sure to configure your .env file first:"
    echo "   cp .env.example .env"
    echo "   # Edit .env with your configuration"
else
    echo "❌ Docker build failed!"
    exit 1
fi