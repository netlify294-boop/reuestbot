# Telegram Join-Request Bot (Render + MongoDB)

Auto-approves channel/group join requests, sends a welcome message with up to
2 configurable buttons, optionally forwards a pinned message — plus a full
in-bot admin panel for `/broadcast` and `/clone`, all stored in MongoDB.

## Deploy on Render

1. Push this folder to a GitHub repo.
2. Create a free MongoDB Atlas cluster (mongodb.com/atlas) → get your
   connection string (looks like `mongodb+srv://user:pass@cluster.../`).
3. Render dashboard → New → Web Service → connect the repo.
4. Build command: `npm install`
5. Start command: `npm start`
6. Environment variables (Settings → Environment):
   - `BOT_TOKEN` — your main bot's token from @BotFather
   - `ADMIN_ID` — your numeric Telegram user ID
   - `MONGODB_URI` — your Atlas connection string
   - `MONGODB_DB` — optional, defaults to `join_request_bot`
   - `CHANNEL_USERNAME` — optional starting value, e.g. `@YourChannel`
     (can also be set later from the admin panel)
   - `FORWARD_MESSAGE_ID` — optional starting value (can also be set later)
   - `RENDER_EXTERNAL_URL` — Render sets this automatically
7. Deploy. On boot the server registers `BOT_TOKEN`'s webhook automatically.
8. Bot must be admin in the channel/group with "Invite users via link"
   permission, and "Approve new members" (join requests) turned ON.

## Using the admin panel

Open a private chat with your bot (as the `ADMIN_ID` account) and send
`/admin` (or `/start`). You'll get inline buttons:

- **Channel set karo** — set/update the channel username used for forwarding
- **Forward message ID set karo** — which message from that channel gets
  forwarded to new users
- **Button 1 / Button 2 set karo** — reply with `Text | https://link.com` to
  attach a link button under every welcome message
- **Current config dekho** — see everything currently set, plus saved user count
- **Broadcast bhejo** — next message you send becomes the broadcast, sent to
  every user this bot has approved
- **Clone bot banao** — reply with a new bot's token (made via @BotFather),
  optionally followed by a different admin's numeric ID, to spin up a full
  copy on the same server

All config lives in MongoDB now, so it survives restarts and redeploys —
no more ephemeral-disk issue.

## Keeping it awake with UptimeRobot

Render's free web services spin down after ~15 minutes of no traffic, then
take a few seconds to wake back up on the next request — which can make the
5-minute join-request window risky. To keep it always warm:

1. Sign up at uptimerobot.com (free).
2. Add New Monitor → type **HTTP(s)**.
3. URL: `https://<your-service>.onrender.com/ping`
4. Monitoring interval: 5 minutes (the shortest on the free plan).
5. Save. UptimeRobot will now hit `/ping` every 5 minutes, which counts as
   traffic and keeps Render from putting the service to sleep.

`/ping` just returns `pong` with a 200 status — no Mongo/Telegram calls, so
it's fast and won't count against any rate limits.

## Limitations to keep in mind

- **The 5-minute window**: Telegram only lets a bot message a user via the
  join-request "implicit permission" for 5 minutes after the request is
  sent (or until it's approved/declined). This code sends the welcome
  message immediately after approving, so it stays inside that window.
- **Cloned bots must exist on Telegram first** — `/clone` only registers and
  wires up a token you already created via @BotFather.
- **Broadcast rate limiting** — messages go out with a small delay each to
  avoid Telegram flood limits; large lists will take a bit longer, that's expected.
- **Admin-panel state** (which question it's waiting for your reply to) is
  kept in memory, not MongoDB — if the server restarts mid-conversation,
  just tap the button again.
