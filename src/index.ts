/**
 * ============================================================
 * Entry Point — Reliability Patterns CLI Chatbot
 * ============================================================
 *
 * This is the main entry point. It:
 * 1. Loads the .env file for the GEMINI_API_KEY
 * 2. Validates the API key is set
 * 3. Starts the interactive chat application
 *
 * Run with: npm start
 */

import * as dotenv from "dotenv";
import { ChatApp } from "./chat";

// Load environment variables from .env file
dotenv.config();

// ── Validate API Key ──

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey || apiKey === "your_gemini_api_key_here") {
  console.error(`
\x1b[31m╔══════════════════════════════════════════════════════╗
║  ❌  GEMINI_API_KEY not configured                    ║
╠══════════════════════════════════════════════════════╣
║                                                      ║
║  1. Get a free API key at:                           ║
║     https://aistudio.google.com/apikey               ║
║                                                      ║
║  2. Add it to your .env file:                        ║
║     GEMINI_API_KEY=your_actual_key_here              ║
║                                                      ║
║  3. Run again: npm start                             ║
║                                                      ║
╚══════════════════════════════════════════════════════╝\x1b[0m
`);
  process.exit(1);
}

// ── Start the Chat Application ──

const app = new ChatApp(apiKey);
app.start();
