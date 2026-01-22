#!/bin/bash

# Package script for Letterboxd DTDD Chrome Extension
# Creates a ZIP file ready for Chrome Web Store upload

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Get version from manifest.json
VERSION=$(grep '"version"' manifest.json | sed 's/.*"version": *"\([^"]*\)".*/\1/')
OUTPUT_FILE="letterboxd-dtdd-v${VERSION}.zip"

# Remove old package if exists
rm -f "$OUTPUT_FILE"

# Create the ZIP with only the required files
zip -r "$OUTPUT_FILE" \
  manifest.json \
  background.js \
  content.js \
  styles.css \
  settings.html \
  settings.js \
  settings.css \
  icons/*.png

echo "Created $OUTPUT_FILE"
echo ""
echo "Next steps:"
echo "  1. Go to https://chrome.google.com/webstore/devconsole"
echo "  2. Click 'New Item' and upload $OUTPUT_FILE"
echo "  3. Fill in store listing details and submit for review"
