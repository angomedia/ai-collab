# AI Collab

Ask one question. Watch Codex and Claude discuss it. Get a final answer judged by a moderator.

AI Collab is a local desktop app for **macOS and Windows**, using your own Codex and Claude Code sign-ins. Attach documents, choose models, watch the conversation, and ask follow-up questions with the previous discussion and files kept in context.

**[Download for Apple Silicon Mac](https://github.com/angomedia/ai-collab/releases/download/v1.7.0/AI-Collab-1.7.0-mac-arm64.dmg)** · **[Download for Intel Mac](https://github.com/angomedia/ai-collab/releases/download/v1.7.0/AI-Collab-1.7.0-mac-x64.dmg)** · **[Download for Windows](https://github.com/angomedia/ai-collab/releases/download/v1.7.0/AI-Collab-1.7.0-win-x64.exe)**

[All releases and release notes](https://github.com/angomedia/ai-collab/releases/latest) · [Report a problem](https://github.com/angomedia/ai-collab/issues) · [How it works](docs/architecture.md)

No coding, Node.js, or developer tools are needed to use the installed app.

**Cost and accounts:** AI Collab is free and open source, with no separate app subscription or API keys. You need an internet connection and your own eligible **Codex and Claude Code** access. AI requests count toward those accounts' usage limits and any optional paid usage you enable. You connect each CLI during setup; a desktop-app login alone may not connect it.

## Download and install

### 1. Download for your computer

| Computer | AI Collab 1.7.0 installer |
| --- | --- |
| Mac with Apple Silicon (M1 or newer) | **[Download for Apple Silicon — DMG](https://github.com/angomedia/ai-collab/releases/download/v1.7.0/AI-Collab-1.7.0-mac-arm64.dmg)** |
| Mac with an Intel processor | **[Download for Intel Mac — DMG](https://github.com/angomedia/ai-collab/releases/download/v1.7.0/AI-Collab-1.7.0-mac-x64.dmg)** |
| Windows PC, Intel or AMD 64-bit | **[Download for Windows — EXE](https://github.com/angomedia/ai-collab/releases/download/v1.7.0/AI-Collab-1.7.0-win-x64.exe)** |

Not sure which Mac you have? Open **Apple menu → About This Mac**: an Apple M-series chip means Apple Silicon; an Intel processor means Intel Mac. Mac ZIP downloads and checksums are also available under **Assets** on the [release page](https://github.com/angomedia/ai-collab/releases/latest). The “Source code” ZIP and TAR files are for developers, not installers. Windows ARM and Linux installers are not included.

### 2. Install and open AI Collab

- **Mac:** open the downloaded `.dmg`, drag **AI Collab** into **Applications**, then open AI Collab from Applications. You can eject the disk image afterward.
- **Windows:** open the downloaded `.exe` and follow the installer. It installs for your Windows account. Open **AI Collab** from the Start menu.

If your system blocks the first launch, see [First-launch security prompts](#first-launch-security-prompts) below.

### 3. Connect your own accounts

Open **Connections** in AI Collab. Choose **Install CLI** for an assistant that is missing, or **Connect** if it is already installed. Finish the official sign-in in the Terminal/PowerShell window and browser that open, then return to the app. Once both assistants show **Connected**, type your question and click Send. [More connection help](#connect-your-accounts).

Requirements: **macOS 13 or later**, or **Windows 10 1809 or later / Windows 11 (x64)**; an internet connection; and Codex and Claude Code access on your accounts. Claude Code must be **2.1.259 or later**. Model availability and usage limits depend on your accounts. See [Claude Code's system requirements](https://code.claude.com/docs/en/setup#system-requirements).

### First-launch security prompts

The Windows installer is **unsigned**. The Mac app is **not Apple Developer ID signed or notarized**. Your system may show an unknown-publisher warning or block launch. Download from this repository's Releases page; its SHA-256 checksums let you check that a download matches the published file.

- **Mac:** for an unidentified-developer or unverified-app warning, first attempt to open AI Collab, then use **System Settings → Privacy & Security → Open Anyway** if you trust the download. Confirm **Open** when prompted. See [Apple's instructions](https://support.apple.com/en-us/102445). Do not disable Gatekeeper globally or treat a malware/damaged-file warning as the same prompt.
- **Windows:** if SmartScreen says “Windows protected your PC” for an unrecognized app and you trust the download, use **More info → Run anyway**, when available. A managed computer may prevent this. Windows Smart App Control can also block unsigned apps and has no individual-app override; see [Microsoft's guidance](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions).

If those options are unavailable, ask your computer's administrator or [report the exact message](https://github.com/angomedia/ai-collab/issues). You do not need to change global security settings to follow this guide.

### Updating an existing installation

1. Finish or stop any active debate, then **quit AI Collab completely** before installing the update.
2. Download the newer installer for the same computer type. On Mac, drag the new app into Applications and choose **Replace**. On Windows, run the new installer over the existing installation.
3. Reopen AI Collab. Your saved chats, attached source text, model defaults, and connection settings remain in the app's separate [local data folder](#privacy-and-storage). Your CLI sign-ins remain managed by the CLIs.

There is no automatic updater yet. You do not need to uninstall the previous version or delete its data folder to update.

## Connect your accounts

1. Open AI Collab. **Connections** appears if either assistant needs setup.
2. Choose **Install CLI** for a missing assistant. The app opens its official installer in Terminal on Mac or PowerShell on Windows, then starts sign-in.
3. If a CLI is already installed, choose **Connect** and finish its browser sign-in.
4. Return to the app. Both assistants should show **Connected**. Use **Refresh status** if needed.

Each person signs into their own accounts. A ChatGPT or Claude desktop-app login alone may not sign in the corresponding CLI. The app does not ask for API keys, copy credential files, or include the publisher's accounts. It removes API-key environment variables from model processes and checks for subscription authentication.

On Windows, install the **native Windows CLIs**. CLIs installed only inside WSL are not used. For custom installations, expand **Connection details → Choose executable**. **Reconnect** opens sign-in again. Official setup references: [Codex](https://learn.chatgpt.com/docs/codex/cli), [Claude Code](https://code.claude.com/docs/en/setup).

## Use the app

Type a question, optionally attach files, then click Send. **⌘ Enter** on Mac or **Ctrl Enter** on Windows also sends it.

- **Models & time:** choose Codex, Claude, and moderator models from dropdowns. Click **Save as defaults** to reuse your choices in new chats and after restarting. Existing chats keep their own choices.
- **Moderator:** uses your Codex connection, so no third login is required. If the default moderator model is unavailable on your account, choose one from the live list and save your defaults.
- **Clarifying questions:** if an important personal detail or constraint is missing, the moderator asks up to three focused questions before the debate. Choose a suggested answer or write your own. The discussion and its timer pause while you answer, and the questions survive an app restart. **Use best judgment** explicitly lets the assistants proceed with stated assumptions instead.
- **Web research:** before the discussion, each assistant checks whether your question depends on something it doesn't reliably know, such as a newly announced product. If so, that assistant searches the web and shares a short brief with sources, which both assistants and the moderator then use. The search sees your question and clarification answers, not your attached files. If a search fails, the discussion continues without it.
- **Discussion:** the moderator refines the question and assigns useful perspectives. Codex and Claude exchange responses, draft an answer, review it, and revise as needed.
- **Short contributions:** GPT-6 Sol turns opening arguments, responses, and drafts into concise takeaways. Expand **Full response** to inspect the original. Summaries are for display; the debate, reviews, and final answer use the full original text. If summarization is unavailable, the original stays accessible.
- **Final answer:** “Both agree” requires both assistants to approve the exact final draft and the moderator to finalize it. “Moderator decision” means the moderator finalized an answer despite remaining disagreement, which stays visible.
- **No fixed number of rounds:** discussion continues until the moderator finalizes or the question's time limit is reached. Stop keeps the partial conversation; a timeout does not manufacture agreement.
- **Follow-ups:** ask in the same chat to retain earlier discussion and uploaded source text. New chat starts fresh.
- **Export:** save the conversation as Markdown.

Perspectives can be opposing views for a tradeoff or complementary checks for a factual task. Agreement does not guarantee correctness. Model calls consume your existing provider usage; clarification, moderation, and GPT-6 Sol display summaries also use Codex requests. Some model choices may require additional credits under your provider settings. A final answer is shown in full, with the two reviewers' agreement or remaining concerns visible.

### Try it

> I work full time and have two children. We spend too many evenings on phones and streaming, but screens also help us relax and stay in touch. Should our household adopt screen-free evenings, keep flexible limits, or try another approach? Consider practicality, fairness between adults and children, and what happens after a stressful day. Give one recommendation, no more than three rules, a two-week trial with observable success criteria, and the biggest tradeoff. Use clearly stated assumptions instead of invented research.

The app assigns the roles. You do not need to tell one model to agree and the other to disagree.

## Attachments

| Format | Mac | Windows |
| --- | --- | --- |
| PDF with selectable text | Yes | Yes |
| Scanned PDF | On-device OCR | Export with a text layer first |
| Word `.docx`, rich text `.rtf` | Yes | Yes |
| Legacy Word `.doc` | Yes | Save as DOCX or text first |
| Excel `.xlsx` | Yes | Yes |
| Text, Markdown, CSV, TSV, JSON | Yes | Yes |

Each chat supports **8 files**, **25 MB per file**, and **200,000 extracted characters total**. Questions can contain up to **20,000 characters**. Click a filename to inspect its extracted text and warnings. Unreadable or oversized documents are rejected rather than silently truncated.

Text extraction does not interpret images or charts. OCR may misread numbers and words. Excel includes sheet names, addresses, formulas, and saved values, including hidden sheets; formulas are not recalculated. Previously shared text stays with the conversation even if the original file changes. Start a new chat to use a different source set without the earlier context.

## Privacy and storage

The interface, document extraction, and saved history run on your computer. **Questions, extracted attachment text, and peer responses are sent to OpenAI and Anthropic** through your signed-in CLIs. Provider data policies and account terms still apply. AI Collab has no separate hosted application backend or analytics service.

This app is for discussion and planning. Shell tools, file editing, MCP integrations, and other agent tools are disabled during debates. The one exception is web search, used only when an assistant needs to look something up; searches run through OpenAI's and Anthropic's own search tools. Search results can be wrong or out of date, so supply the facts you already have.

Local data is kept outside the installed app:

- Mac: `~/Library/Application Support/AI Collab/`
- Windows: `%APPDATA%\AI Collab\`

This contains `debates/runs/` (history and shared source text), `attachments/` (imported text and metadata), `preferences.json` (saved defaults), and `connections.json` (selected executable paths). **Help → Show saved debates** opens the history folder. Original documents are untouched. Provider credentials remain managed by the CLIs.

Installing an update preserves this data; follow [Updating an existing installation](#updating-an-existing-installation). Uninstalling the app does not intentionally erase your history or sign you out of the CLIs; remove its data folder separately if you want that history deleted. Never attach this folder or credential files to a public issue.

## Troubleshooting

- **CLI installed but not found:** refresh Connections, restart the app, or choose the executable under Connection details. On Windows, use a native `.exe` or `.cmd` installation.
- **Model unavailable:** refresh the model list and select a model your account can use. The app preserves saved selections instead of silently switching models.
- **Setup remains pending:** finish or close the Terminal/PowerShell setup flow, then refresh status. Setup must finish before a discussion starts.
- **Unknown CLI option:** update the affected CLI using its official instructions and reconnect. CLI changes may require an AI Collab update; report the CLI and app versions if it persists.
- **Moderator cannot produce a valid plan:** use **Use question again**, or choose another available moderator model. Invalid plans never start an unmoderated debate.
- **Windows PDF contains no text:** export it as a searchable PDF or upload its text. Scanned-PDF OCR is currently Mac-only.

For a bug report, include your OS, AI Collab version, CLI versions, and error text. Remove personal information. Do not post tokens, documents, or full private conversation logs.

## Develop and build (optional)

This section is for people who want to change the code or build the app themselves. To use AI Collab, install one of the downloads above.

Use Node.js **22.13 or later**. A Mac build also needs Apple's command-line developer tools (`xcode-select --install`) for the Swift PDF/OCR helper. Tests use isolated temporary data and fake providers; the normal test commands do not use your model accounts.

```sh
git clone https://github.com/angomedia/ai-collab.git
cd ai-collab
npm ci
npm run build:reader   # Builds the helper on Mac; skips on Windows
npm start
```

```sh
npm test
npm run test:gui
npm run package       # Unpacked native app in dist/
npm run dist          # Installers for the current platform/architecture
```

For live account diagnostics, `npm run smoke` checks local CLI installation and login status. `npm run smoke -- --full` runs a real discussion and consumes provider usage. Development-only `AI_COLLAB_DATA_DIR` isolates history; `AI_COLLAB_CODEX_PATH` and `AI_COLLAB_CLAUDE_PATH` select CLIs. The packaged app ignores the data-directory override.

[Release and signing instructions](docs/releases.md) describe the GitHub Actions builds. See [architecture](docs/architecture.md) for the moderator, conversation state, structured validation, subprocess isolation, and renderer.

## License

AI Collab's source is available under the [MIT license](LICENSE). Dependencies retain their own licenses and terms. Codex and Claude Code are installed separately through their official installers. This is an independent community app, not an official OpenAI or Anthropic product.
