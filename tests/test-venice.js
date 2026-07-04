#!/usr/bin/env node

// Simple test script for Venice AI connection
// Tests that Venice AI no longer receives the unsupported 'think' parameter
// Run: bun test-venice.js

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function testVenice() {
  console.log('Testing Venice AI connection with local zai-cli build...\n');

  if (!process.env.VENICE_API_KEY) {
    console.error('Error: VENICE_API_KEY not found in environment');
    process.exit(1);
  }

  const cliPath = path.join(__dirname, '..', 'dist', 'index.js');

  console.log('Starting zai-cli with Venice backend...');
  console.log('Command: node ../dist/index.js -b venice -u https://api.venice.ai/api/v1 -m llama-3.3-70b -k $VENICE_API_KEY --auto-approve -p "Say hello"\n');

  const grok = spawn('node', [
    cliPath,
    '-b', 'venice',
    '-u', 'https://api.venice.ai/api/v1',
    '-m', 'llama-3.3-70b',
    '-k', process.env.VENICE_API_KEY,
    '--auto-approve',
    '-p', 'Say hello'
  ], {
    env: { ...process.env },
    stdio: ['inherit', 'pipe', 'pipe']
  });

  let output = '';
  let errorOutput = '';

  grok.stdout.on('data', (data) => {
    output += data.toString();
    process.stdout.write(data);
  });

  grok.stderr.on('data', (data) => {
    errorOutput += data.toString();
    process.stderr.write(data);
  });

  grok.on('close', (code) => {
    const allOutput = output + errorOutput;

    // Check for HTTP 400 error (the bug we're testing for)
    if (allOutput.includes('400') || allOutput.includes('Bad Request')) {
      console.error('\n❌ FAILED! HTTP 400 error detected - the fix is not working');
      process.exit(1);
    }

    // Check for other errors (not the bug we're fixing, but still failures)
    if (allOutput.includes('encountered an error') ||
        allOutput.includes('Authentication failed') ||
        allOutput.includes('API error')) {
      console.error('\n⚠️  Test encountered other errors (not HTTP 400)');
      console.error('This might be an API key issue or other problem, not the bug being fixed.');
      process.exit(1);
    }

    // Check for successful response
    if (allOutput.toLowerCase().includes('hello')) {
      console.log('\n✅ SUCCESS! Venice AI connection working correctly - no HTTP 400 error!');
      process.exit(0);
    }

    // Unclear result
    console.log('\n⚠️  Unclear result - check output above');
    process.exit(1);
  });
}

testVenice();
