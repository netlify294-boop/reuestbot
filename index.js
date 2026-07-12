import express from "express";
import {
  connectDB,
  getBot,
  ensureBot,
  updateBot,
  saveUser,
  removeUser,
  getUsers,
  countUsers
} from "./db.js";

const app = express();
app.use(express.json());

const MAIN_BOT_TOKEN = process.env.BOT_TOKEN;
const MAIN_ADMIN_ID = process.env.ADMIN_ID;
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME || "";
const FORWARD_MESSAGE_ID = process.env.FORWARD_MESSAGE_ID ? Number(process.env.FORWARD_MESSAGE_ID) : null;
// Render sets this automatically for every web service
const BASE_URL = process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL;

if (!MAIN_BOT_TOKEN || !MAIN_ADMIN_ID) {
  console.error("Missing BOT_TOKEN or ADMIN_ID env vars. Set them in Render dashboard.");
}

// in-memory "what is this admin currently typing an answer for" tracker.
// Fine to lose this on restart — it's just mid-conversation UI state, not data.
const pending = new Map(); // key: `${token}:${adminId}` -> action string

function pendingKey(token, adminId) {
  return `${token}:${adminId}`;
}

// ---------- Telegram API helper ----------
async function tgApi(token, method, data) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  return res.json();
}

async function setWebhook(token) {
  if (!BASE_URL) {
    console.warn("BASE_URL not available yet, skipping webhook setup for", token.slice(0, 8));
    return null;
  }
  const url = `${BASE_URL}/webhook/${token}`;
  const result = await tgApi(token, "setWebhook", {
    url,
    allowed_updates: ["message", "chat_join_request", "callback_query"]
  });
  console.log("setWebhook", token.slice(0, 8), result.ok, result.description || "");
  return result;
}

// ---------- broadcast ----------
async function broadcast(token, text) {
  const users = await getUsers(token);
  let sent = 0;
  let failed = 0;

  for (const userId of users) {
    try {
      const result = await tgApi(token, "sendMessage", { chat_id: userId, text });
      if (result.ok) {
        sent++;
      } else {
        failed++;
        if (result.error_code === 403) await removeUser(token, userId);
      }
    } catch (e) {
      failed++;
    }
    await new Promise((r) => setTimeout(r, 40)); // stay under flood limits
  }

  return { sent, failed, total: users.length };
}

// ---------- welcome message + configured buttons ----------
function buildWelcomeKeyboard(botConfig) {
  const row = [];
  if (botConfig.button1 && botConfig.button1.text && botConfig.button1.url) {
    row.push({ text: botConfig.button1.text, url: botConfig.button1.url });
  }
  if (botConfig.button2 && botConfig.button2.text && botConfig.button2.url) {
    row.push({ text: botConfig.button2.text, url: botConfig.button2.url });
  }
  if (row.length === 0) return undefined;
  return { inline_keyboard: [row] };
}

// ---------- admin panel keyboard ----------
function adminPanelKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📢 Channel set karo", callback_data: "set_channel" }],
      [{ text: "📨 Forward message ID set karo", callback_data: "set_forward_id" }],
      [{ text: "🔘 Button 1 set karo", callback_data: "set_button1" }],
      [{ text: "🔘 Button 2 set karo", callback_data: "set_button2" }],
      [{ text: "📊 Current config dekho", callback_data: "view_config" }],
      [{ text: "📤 Broadcast bhejo", callback_data: "do_broadcast" }],
      [{ text: "🧬 Clone bot banao", callback_data: "do_clone" }]
    ]
  };
}

function formatConfig(botConfig, userCount) {
  return (
    "*Current config*\n\n" +
    `Channel: ${botConfig.channelUsername || "(not set)"}\n` +
    `Forward message ID: ${botConfig.forwardMessageId ?? "(not set)"}\n` +
    `Button 1: ${botConfig.button1 ? `${botConfig.button1.text} → ${botConfig.button1.url}` : "(not set)"}\n` +
    `Button 2: ${botConfig.button2 ? `${botConfig.button2.text} → ${botConfig.button2.url}` : "(not set)"}\n` +
    `Saved users: ${userCount}`
  );
}

// ---------- webhook (shared by main bot AND every cloned bot) ----------
app.post("/webhook/:token", async (req, res) => {
  const token = req.params.token;
  const botConfig = await getBot(token);

  if (!botConfig) return res.status(404).send("Unknown bot");

  const update = req.body;

  try {
    // 1) Join request -> approve + welcome (with buttons) + optional forward
    if (update.chat_join_request) {
      const chatId = update.chat_join_request.chat.id;
      const userId = update.chat_join_request.from.id;

      await tgApi(token, "approveChatJoinRequest", { chat_id: chatId, user_id: userId });
      await saveUser(token, userId);

      await tgApi(token, "sendMessage", {
        chat_id: userId,
        text: "✅ Your join request has been accepted! Welcome.",
        reply_markup: buildWelcomeKeyboard(botConfig)
      });

      if (botConfig.channelUsername && botConfig.forwardMessageId) {
        await tgApi(token, "forwardMessage", {
          chat_id: userId,
          from_chat_id: botConfig.channelUsername,
          message_id: botConfig.forwardMessageId
        });
      }
    }

    // 2) Callback queries from the admin panel's inline buttons
    if (update.callback_query) {
      const cq = update.callback_query;
      const fromId = String(cq.from.id);
      const data = cq.data;
      const isAdmin = fromId === String(botConfig.adminId);

      await tgApi(token, "answerCallbackQuery", { callback_query_id: cq.id });

      if (!isAdmin) {
        return res.send("OK");
      }

      if (data === "view_config") {
        const count = await countUsers(token);
        await tgApi(token, "sendMessage", {
          chat_id: fromId,
          text: formatConfig(botConfig, count),
          parse_mode: "Markdown"
        });
      } else if (data === "set_channel") {
        pending.set(pendingKey(token, fromId), "channel");
        await tgApi(token, "sendMessage", {
          chat_id: fromId,
          text: "Channel username bhejo (jaise @YourChannel):"
        });
      } else if (data === "set_forward_id") {
        pending.set(pendingKey(token, fromId), "forward_id");
        await tgApi(token, "sendMessage", {
          chat_id: fromId,
          text: "Us channel wale message ki ID bhejo jise forward karna hai (sirf number):"
        });
      } else if (data === "set_button1") {
        pending.set(pendingKey(token, fromId), "button1");
        await tgApi(token, "sendMessage", {
          chat_id: fromId,
          text: 'Button 1 ke liye "Text | https://link.com" is format mein bhejo:'
        });
      } else if (data === "set_button2") {
        pending.set(pendingKey(token, fromId), "button2");
        await tgApi(token, "sendMessage", {
          chat_id: fromId,
          text: 'Button 2 ke liye "Text | https://link.com" is format mein bhejo:'
        });
      } else if (data === "do_broadcast") {
        pending.set(pendingKey(token, fromId), "broadcast");
        await tgApi(token, "sendMessage", {
          chat_id: fromId,
          text: "Jo message broadcast karna hai wo ab bhejo:"
        });
      } else if (data === "do_clone") {
        pending.set(pendingKey(token, fromId), "clone");
        await tgApi(token, "sendMessage", {
          chat_id: fromId,
          text: 'Naye bot ka token bhejo. Agar alag admin chahiye to "TOKEN admin_id" format mein bhejo:'
        });
      }

      return res.send("OK");
    }

    // 3) Plain messages: /start, /admin, and answers to pending admin prompts
    if (update.message && update.message.text) {
      const msg = update.message;
      const fromId = String(msg.from.id);
      const text = msg.text.trim();
      const isAdmin = fromId === String(botConfig.adminId);
      const pKey = pendingKey(token, fromId);

      // handle a pending admin-panel answer first
      if (isAdmin && pending.has(pKey)) {
        const action = pending.get(pKey);
        pending.delete(pKey);

        if (action === "channel") {
          await updateBot(token, { channelUsername: text });
          await tgApi(token, "sendMessage", { chat_id: fromId, text: `✅ Channel set: ${text}` });
        } else if (action === "forward_id") {
          const id = Number(text);
          if (Number.isNaN(id)) {
            await tgApi(token, "sendMessage", { chat_id: fromId, text: "Ye number nahi hai, dobara try karo /admin se." });
          } else {
            await updateBot(token, { forwardMessageId: id });
            await tgApi(token, "sendMessage", { chat_id: fromId, text: `✅ Forward message ID set: ${id}` });
          }
        } else if (action === "button1" || action === "button2") {
          const [btnText, btnUrl] = text.split("|").map((s) => s.trim());
          if (!btnText || !btnUrl) {
            await tgApi(token, "sendMessage", {
              chat_id: fromId,
              text: 'Format galat hai. Dobara /admin se try karo: "Text | https://link.com"'
            });
          } else {
            await updateBot(token, { [action]: { text: btnText, url: btnUrl } });
            await tgApi(token, "sendMessage", { chat_id: fromId, text: `✅ ${action} set: ${btnText} → ${btnUrl}` });
          }
        } else if (action === "broadcast") {
          await tgApi(token, "sendMessage", { chat_id: fromId, text: "Broadcast shuru ho raha hai..." });
          const result = await broadcast(token, text);
          await tgApi(token, "sendMessage", {
            chat_id: fromId,
            text: `Broadcast complete.\nSent: ${result.sent}\nFailed: ${result.failed}\nTotal users: ${result.total}`
          });
        } else if (action === "clone") {
          const parts = text.split(" ").filter(Boolean);
          const newToken = parts[0];
          const newAdminId = parts[1] || botConfig.adminId;

          await ensureBot(newToken, {
            adminId: newAdminId,
            channelUsername: botConfig.channelUsername,
            forwardMessageId: botConfig.forwardMessageId,
            button1: botConfig.button1,
            button2: botConfig.button2
          });

          const webhookResult = await setWebhook(newToken);

          if (webhookResult && webhookResult.ok) {
            await tgApi(token, "sendMessage", {
              chat_id: fromId,
              text: "✅ Clone ban gaya! Naya bot ab live hai, same features ke saath."
            });
          } else {
            await tgApi(token, "sendMessage", {
              chat_id: fromId,
              text: "❌ Clone fail ho gaya — token galat ho sakta hai ya webhook set nahi ho paya."
            });
          }
        }

        return res.send("OK");
      }

      // regular commands
      if (text === "/start" || text === "/admin") {
        if (isAdmin) {
          await tgApi(token, "sendMessage", {
            chat_id: fromId,
            text: "Admin panel:",
            reply_markup: adminPanelKeyboard()
          });
        }
      }
    }
  } catch (err) {
    console.error("Webhook error:", err);
  }

  res.send("OK");
});

app.get("/", (req, res) => res.send("Bot server running"));

// Dedicated health-check endpoint for uptime monitors (UptimeRobot etc.)
// Point your monitor at: https://<your-service>.onrender.com/ping
app.get("/ping", (req, res) => res.status(200).send("pong"));

const PORT = process.env.PORT || 3000;

connectDB()
  .then(async () => {
    await ensureBot(MAIN_BOT_TOKEN, {
      adminId: MAIN_ADMIN_ID,
      channelUsername: CHANNEL_USERNAME,
      forwardMessageId: FORWARD_MESSAGE_ID
    });
    await setWebhook(MAIN_BOT_TOKEN);
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error("Failed to connect to MongoDB:", err);
    process.exit(1);
  });