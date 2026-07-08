# Jira Attachment Downloader

A cross-platform (macOS + Windows) desktop app that downloads **all attachments
for a given Jira Cloud project** into a folder of your choice.

![desktop app](https://img.shields.io/badge/platform-mac%20%7C%20windows-6366f1)

## Features

- Connect to any Jira Cloud site with your email + API token
- Test the connection before running
- Downloads every attachment across every issue in a project (paginated)
- Optionally organizes files into a subfolder per issue
- Live progress bar, running total, and log
- Remembers your site / email / project / folder (the API token is never stored)

## First-time setup

You need [Node.js](https://nodejs.org) installed (LTS is fine).

```bash
npm install
npm start
```

## Getting a Jira API token

1. Go to https://id.atlassian.com/manage-profile/security/api-tokens
2. Click **Create API token**, give it a name, and copy it.
3. In the app, enter:
   - **Jira site URL** — e.g. `yourcompany.atlassian.net`
   - **Email** — the email you log into Jira with
   - **API token** — the token you just created

## Using it

1. Click **Test connection** to confirm your credentials.
2. Enter a **Project key** (the prefix on issue IDs, e.g. `ABC` in `ABC-123`).
3. Choose a **download folder**.
4. Click **Download all attachments**.

Files are saved to `<folder>/<PROJECT> attachments/<ISSUE-KEY>/<filename>`.

## Building installable apps

Create a double-click installer for your platform:

```bash
npm run dist:mac    # .dmg + .zip (run on a Mac)
npm run dist:win    # .exe installer (run on Windows)
```

Output appears in the `release/` folder.

> Note: build the macOS app on a Mac and the Windows app on Windows for best results.

## Privacy

Everything runs locally on your machine. Your credentials are sent only to your
own Jira site. The API token is kept in memory and is never written to disk.
