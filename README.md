# Ain't

A lightweight, browser-only AI chat client built for static hosting.

It keeps the minimal Everforest-inspired look, stores every chat and provider locally in the browser, and works on free static hosts like Vercel, Netlify, or GitHub Pages.

## What it does

- Stores providers, chats, and selected model in localStorage
- Connects to OpenAI-compatible APIs directly from the browser
- Lists models from each provider and keeps a single active model selector
- Streams responses with markdown and KaTeX support
- Keeps the UI intentionally small and clean

## Static hosting

This app is designed to run as a static page with no backend or database. Upload the project as-is to a static host and open it in a browser.

Important: the provider must allow browser requests (CORS). Many OpenAI-compatible providers do, but some require server-side proxies.

## Provider setup

Add a provider with:

- a display name
- the base URL for an OpenAI-compatible API such as `https://api.groq.com/openai/v1`
- your API key

Use the built-in Test Connection button to hit `/models` and verify that the endpoint is reachable before saving. A sample placeholder or a real key is enough to confirm the client can reach the provider.

## Local data

All user data is kept in the browser with `localStorage` instead of a server. That means chats and keys stay on the user's device and are not stored in a backend or database.

## Notes

- This project intentionally avoids extra frameworks and server code.
- The app is intentionally minimal: a single HTML file, a stylesheet, and a small JavaScript client.
- If a provider returns an auth or CORS error, the app surfaces that directly so the user can fix the setup quickly.
