# Ollama Chat — Self-Hosted AI Chat + Agentic Project Assistant

A self-hosted, ChatGPT/Claude-style chat app that runs entirely on your
own computer, talks to free Ollama Cloud models, and can open a project
folder to read and edit your code — like a local Cursor/Claude Code.

This guide assumes **zero prior setup**. Follow it top to bottom.

---

## Option A: Just run the .exe (no Node.js, no git)

1. Go to this repo's **Releases** page and download `ollama-chat-win.exe`.
2. Install Ollama and pull the models (Steps 2–3 below still apply — the
   .exe still needs Ollama running locally).
3. Double-click `ollama-chat-win.exe`. A console window opens, runs
   pre-flight checks, then prints your local URL, Tailscale URL, and
   app token — open the local URL in your browser.
4. `.app_token` is created next to the `.exe`, and `chats.db` is created
   in a `db\` subfolder next to the `.exe`, on first run. To reset
   everything, delete `.app_token` and the `db\` folder.

If the window shows a `[FATAL]` message and closes only after you press
a key, it means Ollama isn't installed or isn't running — follow the
printed instructions, then relaunch.

## Option B: Run from source (developers)

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

## 3. Sign in to Ollama, then download the free AI models

Cloud models require you to be signed in, or every pull/chat below will
fail with "You need to be signed in to Ollama to run Cloud models."
Run this first and complete the sign-in in your browser:
```
ollama signin
```
Then open a terminal and run each of these one at a time (each may take a
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

Confirm all seven are installed:
```
ollama list
```
You should see all seven names listed.

> **Model names may change.** If any `pull` command fails, run
> `ollama search gpt-oss` (or `nemotron`, `gemma`) to find the current
> exact name, and use that instead.

## 4. Download this project

**If you have git installed:**
```
git clone <this-repository-url>
cd ollama-chat
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

The server auto-generates `.app_token` on first run if `APP_TOKEN` isn't
set — you don't need to set anything manually. **Windows:** `start.bat`
also does this for you automatically — skip this box.
**Mac/Linux, using `start.sh`:** nothing to do — `start.sh` generates `.app_token`
automatically (like `start.bat`) and prints the full URL with the token included.
**Mac/Linux, only if running `node server.js` directly (not `start.sh`):** set it yourself:
````bash
export APP_TOKEN=$(openssl rand -hex 16)
echo "Your token: $APP_TOKEN"   # copy this for step 7
````
**Windows PowerShell (only if running `node server.js` directly instead of
`start.bat`):**
````powershell
$env:APP_TOKEN = -join (1..32 | %{ '{0:x}' -f (Get-Random -Maximum 16) })
echo "Your token: $env:APP_TOKEN"
````

**Windows:** double-click `start.bat`.

**Mac/Linux, or if `start.bat` doesn't work:** in the terminal, run:
```
chmod +x start.sh
./start.sh
```

**If you want to directly run using node
```
node server.js
```

You should see:
```
Ollama Chat running at http://localhost:3000/?token=<your-token>
Ollama endpoint: http://localhost:11434
Default model: gpt-oss:120b-cloud
```

## 7. Open the app

Open your web browser and go to (replace `<token>` with your `APP_TOKEN`
value — check `.app_token` on Windows, or what you set with `export` on
Mac/Linux):
http://localhost:3000/?token=<token>
Only needed the first time — the token is cached in your browser after
that.
You're chatting with a free Ollama Cloud model.

---

## Accessing from your phone (Tailscale)

`start.bat` prints a Tailscale URL (e.g. `http://100.x.x.x:3000`). This is
a different address than `localhost`, so your browser won't have the
token cached — open it once as `http://100.x.x.x:3000/?token=<token>`
(same token from `.app_token`/step 6) to authorize that device too.

> **⚠️ Security note:** anyone holding this token can read/write any file
> on this machine and run arbitrary shell commands via the agent's
> `execute_command`/`write_file` tools (gated only by an in-chat
> approve/reject prompt). Only share the token over Tailscale with
> devices you trust, and never expose this server's port to the public
> internet.

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
   run `$env:PORT=3001; node server.js` (Windows PowerShell) / `set PORT=3001&&node server.js`
  (Windows CMD) / `PORT=3001 node server.js` (Mac/Linux) and open `http://localhost:3001/?token=<token>` instead.
- **"Unauthorized" / 401 errors** → your URL is missing `?token=<token>`, or you're using an old cached token after regenerating `.app_token`/re-exporting `APP_TOKEN`. Clear it with `localStorage.removeItem("app_token")` in the browser console, then reopen with the correct `?token=`.

## Building your own standalone executable

Requires Node.js and this repo cloned locally.

```bash
npm install
npm run build:win   # Windows .exe → dist/ollama-chat-win.exe
npm run build:mac   # macOS binary → dist/ollama-chat-mac
npm run build:linux # Linux binary → dist/ollama-chat-linux
npm run build:all   # all three
```

The output is fully standalone — Node.js is embedded, and `public/`
plus `sql.js`'s WebAssembly file are bundled in via the `pkg` config in
`package.json`. Only Ollama remains an external runtime requirement.
`.app_token` and the `db\` folder (containing `chats.db`) are always
written next to the compiled binary (see `paths.js`/`db.js`), never
inside the binary itself.
