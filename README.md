# Jira Attachment Downloader

A cross-platform (macOS + Windows) desktop app that downloads **all attachments
for a given Jira Cloud project** into a folder of your choice.

![desktop app](https://img.shields.io/badge/platform-mac%20%7C%20windows-6366f1)

## Features

- Connect to any Jira Cloud site with your email + API token
- Test the connection before running
- Downloads every attachment across every issue in **one or more projects** (paginated)
- **Pick projects from a searchable list** (or type keys manually)
- Optional **date range** filter by the attachment's upload date
- Optionally organizes files into a subfolder per issue
- Live progress bar, running total, and log
- Remembers your site / email / projects / dates / folder (the API token is never stored)

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
2. Enter one or more **Project keys** (the prefix on issue IDs, e.g. `ABC` in `ABC-123`). Separate multiple projects with commas or spaces, e.g. `ABC, DEV, OPS` — or click **Load my projects** to pick them from a searchable checklist.
3. Optionally set a **From / To date** range to only grab attachments uploaded in that window.
4. Choose a **download folder**.
5. Click **Download all attachments**.

Files are saved to `<folder>/<PROJECT> attachments/<ISSUE-KEY>/<filename>`.
When downloading from multiple projects, files are grouped as
`<folder>/Jira attachments/<PROJECT>/<ISSUE-KEY>/<filename>`.

## Building installable apps

Create a double-click installer for your platform:

```bash
npm run dist:mac    # .dmg + .zip (run on a Mac)
npm run dist:win    # .exe installer (run on Windows)
```

Output appears in the `release/` folder.

> Note: build the macOS app on a Mac and the Windows app on Windows for best results.

## Signing & notarizing the macOS app

By default `npm run dist:mac` will code-sign and notarize the app so users don't
see the "unidentified developer" / Gatekeeper warning. This requires:

1. A paid **Apple Developer Program** membership.
2. A **Developer ID Application** certificate installed in your login keychain
   (create it in Xcode → Settings → Accounts → Manage Certificates, or on the
   Apple Developer website, then download and double-click it).
3. An **app-specific password** for your Apple ID
   (appleid.apple.com → Sign-In and Security → App-Specific Passwords).
4. Your 10-character **Team ID** (developer.apple.com → Membership).

Then build with the credentials set as environment variables:

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="ABCDE12345"
npm run dist:mac
```

The signing certificate is picked up automatically from your keychain, and the
app is notarized via Apple's notary service (this can take a few minutes).

If you just want a quick local build **without** signing, run:

```bash
npm run dist:mac:unsigned
```

## Privacy

Everything runs locally on your machine. Your credentials are sent only to your
own Jira site. The API token is kept in memory and is never written to disk.
