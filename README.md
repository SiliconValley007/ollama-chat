# Claude Chat — Self-Hosted AI Chat + Agentic Project Assistant

A self-hosted, ChatGPT/Claude-style chat app that runs entirely on your
own computer, talks to free Ollama Cloud models, and can open a project
folder to read and edit your code — like a local Cursor/Claude Code.

This guide assumes **zero prior setup**. Follow it top to bottom.

---

## 1. Install Node.js

Node.js runs the app's server.

1. Go to https://nodejs.org
2. Download the **LTS** version (the button on the left, not "Current").
3. Run the installer, click Next through every screen, accept defaults.
4. Confirm it worked: open a terminal (Windows: press `Win`, type
   `PowerShell`, press Enter) and run:
   ```
   node -v
   ```
   You should see a version number like `v20.x.x`. If you see an error,
   restart your computer and try again.

## 2. Install Ollama

Ollama runs the AI models.

1. Go to https://ollama.com/download
2. Download and install it for your operating system (Windows/Mac/Linux),
   accepting all defaults.
3. Create a free account at https://ollama.com when prompted — this is
   required to use the free cloud models below.
4. Open a terminal and confirm it's installed:
   ```
   ollama --version
   ```

## 3. Download the free AI models

Open a terminal and run each of these one at a time (each may take a
minute):
```
ollama pull gpt-oss:120b-cloud
ollama pull gpt-oss:20b-cloud
ollama pull nemotron-3-nano:30b-cloud
ollama pull nemotron-3-super:cloud
ollama pull nemotron-3-ultra:cloud
ollama pull gemma4:31b-cloud
ollama pull nomic-embed-text
```
These run on Ollama's free cloud tier — they don't use your computer's
GPU and download almost nothing (just a small pointer file), but you do
need an internet connection every time you chat.
Unlike the -cloud models above (which are just pointers to Ollama's hosted models and download almost nothing), nomic-embed-text is a small model that actually runs locally and downloads a real (~270MB) file — it powers the "📁 Open Project Folder" semantic code search (search_codebase), not chat.

Confirm all six are installed:
```
ollama list
```
You should see all six names listed.

> **Model names may change.** If any `pull` command fails, run
> `ollama search gpt-oss` (or `nemotron`, `gemma`) to find the current
> exact name, and use that instead.

## 4. Download this project

**If you have git installed:**
```
git clone <this-repository-url>
cd claude-chat
```

**If you don't have git:** click the green "Code" button on this GitHub
page → "Download ZIP" → extract it anywhere → open a terminal inside
the extracted folder.

## 5. Install the project's dependencies

Still in the terminal, inside the project folder, run:
```
npm install
```
This downloads the small libraries the app needs (a few seconds to a
couple minutes).

## 6. Start the app

**Windows:** double-click `start.bat`.

**Mac/Linux, or if `start.bat` doesn't work:** in the terminal, run:
```
node server.js
```

You should see:
```
Claude Chat running at http://0.0.0.0:3000
Ollama endpoint: http://localhost:11434
Default model: gpt-oss:120b-cloud
```

## 7. Open the app

Open your web browser and go to:
```
http://localhost:3000
```
You're chatting with a free Ollama Cloud model.

---

## Using the "Open Project Folder" feature (Cursor-style)

Click **📁 Open Project Folder** in the sidebar and paste the full path
to any folder on your computer (e.g. `C:\Users\you\my-project`). The AI
can then read files in that folder, and — if you ask it to make
changes — edit or create files directly. **This writes real changes to
real files with no undo built in.** Before using this on anything you
care about, make sure the folder is tracked with `git` so you can always
revert:
```
cd your-project-folder
git init
git add .
git commit -m "before AI edits"
```

## Keeping semantic search up to date

The project is indexed automatically the moment you open a folder, which
is what powers the AI's `search_codebase` tool. If you then ask the AI
(or edit files yourself) to add, remove, or significantly change files,
click the small **🔄** button next to the file count in the sidebar to
re-index — otherwise semantic search results may reflect the old
version of the files. You don't need to click it after every single
edit; it's only needed before you rely on `search_codebase` again after
a batch of changes.

## Checking your real Ollama usage/quota

Click the "🔋 Check usage" link in the top bar — it opens
`https://ollama.com/settings` in your normal browser, where you can see
your exact usage and when it resets. (An earlier version of this app
tried to scrape this automatically; it was removed because it required
copying real browser session data, which is a security risk not worth
the convenience.)

## Automatic model fallback

If your current model's free quota runs out mid-conversation, the app
automatically retries with the next model in the list in
`modelRouter.js` — you don't have to do anything, and the chat continues
without interruption.

## Troubleshooting

- **"Cannot connect to Ollama"** → Ollama isn't running. Open the Ollama
  app, or run `ollama serve` in a terminal, then reload the page.
- **A model doesn't respond / errors out** → run `ollama list` and
  confirm the exact model name matches what's shown in the app's model
  switcher (top right).
- **Port 3000 already in use** → close whatever else is using it, or
  run `set PORT=3001 && node server.js` (Windows) / `PORT=3001 node
  server.js` (Mac/Linux) and open `http://localhost:3001` instead.
