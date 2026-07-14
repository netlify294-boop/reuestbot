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
const MAIN_CHANNEL_USERNAME = process.env.MAIN_CHANNEL_USERNAME || "";
const FORWARD_CHANNEL_USERNAME = process.env.FORWARD_CHANNEL_USERNAME || process.env.CHANNEL_USERNAME || "";
const FORWARD_MESSAGE_ID = process.env.FORWARD_MESSAGE_ID ? Number(process.env.FORWARD_MESSAGE_ID) : null;
// Render sets this automatically for every web service
const BASE_URL = process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL;

if (!MAIN_BOT_TOKEN || !MAIN_ADMIN_ID) {
  console.error("Missing BOT_TOKEN or ADMIN_ID env vars. Set them in Render dashboard.");
}

// in-memory "what is this admin currently answering" tracker.
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

// ---------- fixed persistent keyboard (stays at bottom of chat, not attached to a message) ----------
function buildReplyKeyboard(botConfig) {
  const row = [];
  if (botConfig.button1 && botConfig.button1.text) row.push({ text: botConfig.button1.text });
  if (botConfig.button2 && botConfig.button2.text) row.push({ text: botConfig.button2.text });
  if (row.length === 0) return undefined;
  return {
    keyboard: [row],
    resize_keyboard: true,
    is_persistent: true
  };
}

// when a user taps one of the fixed keyboard buttons, Telegram sends its
// label back as a plain text message — reply with an inline link button,
// since only inline buttons can actually open a URL
function matchConfiguredButton(botConfig, text) {
  if (botConfig.button1 && botConfig.button1.text === text) return botConfig.button1;
  if (botConfig.button2 && botConfig.button2.text === text) return botConfig.button2;
  return null;
}

// ---------- send the welcome message (any content type, formatting/premium emoji intact) ----------
async function sendWelcome(token, userId, botConfig) {
  const keyboard = buildReplyKeyboard(botConfig);

  if (botConfig.welcomeMessageRef) {
    // copyMessage reproduces the original message exactly — text formatting,
    // premium/custom emoji entities, photos, videos, stickers, whatever it was —
    // and reply_markup lets us still attach our own fixed buttons underneath.
    const result = await tgApi(token, "copyMessage", {
      chat_id: userId,
      from_chat_id: botConfig.welcomeMessageRef.chatId,
      message_id: botConfig.welcomeMessageRef.messageId,
      reply_markup: keyboard
    });
    if (result.ok) return result;
    // fall through to default text if the stored message became inaccessible
  }

  return tgApi(token, "sendMessage", {
    chat_id: userId,
    text: "✅ Your join request has been accepted! Welcome.",
    reply_markup: keyboard
  });
}

// ---------- broadcast: copies whatever message the admin sent (text/photo/video/forwarded/etc.) ----------
async function broadcastCopy(token, fromChatId, messageId, botConfig) {
  const users = await getUsers(token);
  const keyboard = buildReplyKeyboard(botConfig);
  let sent = 0;
  let failed = 0;

  for (const userId of users) {
    try {
      const result = await tgApi(token, "copyMessage", {
        chat_id: userId,
        from_chat_id: fromChatId,
        message_id: messageId,
        reply_markup: keyboard
      });
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

// ---------- send the /start message shown to regular (non-admin) users ----------
async function sendStartMessage(token, userId, botConfig) {
  const keyboard = buildReplyKeyboard(botConfig);

  if (botConfig.startMessageRef) {
    const result = await tgApi(token, "copyMessage", {
      chat_id: userId,
      from_chat_id: botConfig.startMessageRef.chatId,
      message_id: botConfig.startMessageRef.messageId,
      reply_markup: keyboard
    });
    if (result.ok) return result;
  }

  return tgApi(token, "sendMessage", {
    chat_id: userId,
    text: "👋 Welcome!",
    reply_markup: keyboard
  });
}

// ---------- admin panel keyboard ----------
function adminPanelKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📢 Main channel set karo", callback_data: "set_main_channel" }],
      [{ text: "↪️ Forward channel set karo", callback_data: "set_forward_channel" }],
      [{ text: "📨 Forward message ID set karo", callback_data: "set_forward_id" }],
      [{ text: "🚀 Start message set karo", callback_data: "set_start_msg" }],
      [{ text: "💬 Welcome message set karo", callback_data: "set_welcome_msg" }],
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
    `Main channel: ${botConfig.mainChannelUsername || "(not set)"}\n` +
    `Forward channel: ${botConfig.forwardChannelUsername || "(not set)"}\n` +
    `Forward message ID: ${botConfig.forwardMessageId ?? "(not set)"}\n` +
    `Start message: ${botConfig.startMessageRef ? "(custom message set)" : "(default text)"}\n` +
    `Welcome message: ${botConfig.welcomeMessageRef ? "(custom message set)" : "(default text)"}\n` +
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
    // 1) Join request -> approve + welcome (copied content + fixed buttons) + optional forward
    if (update.chat_join_request) {
      const chatId = update.chat_join_request.chat.id;
      const userId = update.chat_join_request.from.id;

      await tgApi(token, "approveChatJoinRequest", { chat_id: chatId, user_id: userId });
      await saveUser(token, userId);

      await sendWelcome(token, userId, botConfig);

      if (botConfig.forwardChannelUsername && botConfig.forwardMessageId) {
        await tgApi(token, "forwardMessage", {
          chat_id: userId,
          from_chat_id: botConfig.forwardChannelUsername,
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

      if (!isAdmin) return res.send("OK");

      const prompts = {
        set_main_channel: "Main channel username bhejo (jaise @YourMainChannel):",
        set_forward_channel: "Forward wale channel ka username bhejo (jaise @YourOtherChannel):",
        set_forward_id: "Us forward-channel wale message ki ID bhejo (sirf number):",
        set_start_msg:
          "Jab koi bina join-request ke direct bot ko /start kare, use kya bhejna hai — ab wo message bhejo (text, photo, premium emoji, kuch bhi):",
        set_welcome_msg:
          "Welcome message ab bhejo — jaisa bhi hai (text, photo, premium emoji, kuch bhi) — waisa hi copy hoke sab naye users ko jayega:",
        set_button1: 'Button 1 ke liye "Text | https://link.com" is format mein bhejo:',
        set_button2: 'Button 2 ke liye "Text | https://link.com" is format mein bhejo:',
        do_broadcast:
          "Jo bhi bhejna hai wo ab bhejo — type karke, ya kahin se forward karke — jaisa bhejoge waisa hi sabko jayega:",
        do_clone: 'Naye bot ka token bhejo. Alag admin chahiye to "TOKEN admin_id" format mein bhejo:'
      };

      if (data === "view_config") {
        const count = await countUsers(token);
        await tgApi(token, "sendMessage", {
          chat_id: fromId,
          text: formatConfig(botConfig, count),
          parse_mode: "Markdown"
        });
      } else if (prompts[data]) {
        pending.set(pendingKey(token, fromId), data.replace(/^(set_|do_)/, ""));
        await tgApi(token, "sendMessage", { chat_id: fromId, text: prompts[data] });
      }

      return res.send("OK");
    }

    // 3) Any plain message: /start, /admin, or the answer to a pending admin-panel prompt.
    // Deliberately not limited to text-only messages, since welcome/broadcast
    // content can be a photo, video, sticker, or forwarded message.
    if (update.message) {
      const msg = update.message;
      const fromId = String(msg.from.id);
      const text = msg.text ? msg.text.trim() : null;
      const isAdmin = fromId === String(botConfig.adminId);
      const pKey = pendingKey(token, fromId);

      if (isAdmin && pending.has(pKey)) {
        const action = pending.get(pKey);
        pending.delete(pKey);

        if (action === "main_channel") {
          if (!text) {
            await tgApi(token, "sendMessage", { chat_id: fromId, text: "Channel username text mein bhejo, jaise @YourChannel." });
          } else {
            await updateBot(token, { mainChannelUsername: text });
            await tgApi(token, "sendMessage", { chat_id: fromId, text: `✅ Main channel set: ${text}` });
          }
        } else if (action === "forward_channel") {
          if (!text) {
            await tgApi(token, "sendMessage", { chat_id: fromId, text: "Channel username text mein bhejo, jaise @YourChannel." });
          } else {
            await updateBot(token, { forwardChannelUsername: text });
            await tgApi(token, "sendMessage", { chat_id: fromId, text: `✅ Forward channel set: ${text}` });
          }
        } else if (action === "forward_id") {
          const id = Number(text);
          if (!text || Number.isNaN(id)) {
            await tgApi(token, "sendMessage", { chat_id: fromId, text: "Ye number nahi hai, /admin se dobara try karo." });
          } else {
            await updateBot(token, { forwardMessageId: id });
            await tgApi(token, "sendMessage", { chat_id: fromId, text: `✅ Forward message ID set: ${id}` });
          }
        } else if (action === "start_msg") {
          await updateBot(token, { startMessageRef: { chatId: msg.chat.id, messageId: msg.message_id } });
          await tgApi(token, "sendMessage", { chat_id: fromId, text: "✅ Start message set. Preview:" });
          const fresh = await getBot(token);
          await sendStartMessage(token, fromId, fresh);
        } else if (action === "welcome_msg") {
          await updateBot(token, { welcomeMessageRef: { chatId: msg.chat.id, messageId: msg.message_id } });
          await tgApi(token, "sendMessage", { chat_id: fromId, text: "✅ Welcome message set. Preview:" });
          // show admin exactly what will be sent, buttons included
          const fresh = await getBot(token);
          await sendWelcome(token, fromId, fresh);
        } else if (action === "button1" || action === "button2") {
          const parts = text ? text.split("|").map((s) => s.trim()) : [];
          const [btnText, btnUrl] = parts;
          if (!btnText || !btnUrl) {
            await tgApi(token, "sendMessage", {
              chat_id: fromId,
              text: 'Format galat hai. /admin se dobara try karo: "Text | https://link.com"'
            });
          } else {
            await updateBot(token, { [action]: { text: btnText, url: btnUrl } });
            await tgApi(token, "sendMessage", { chat_id: fromId, text: `✅ ${action} set: ${btnText} → ${btnUrl}` });
          }
        } else if (action === "broadcast") {
          await tgApi(token, "sendMessage", { chat_id: fromId, text: "Broadcast shuru ho raha hai..." });
          const result = await broadcastCopy(token, msg.chat.id, msg.message_id, botConfig);
          await tgApi(token, "sendMessage", {
            chat_id: fromId,
            text: `Broadcast complete.\nSent: ${result.sent}\nFailed: ${result.failed}\nTotal users: ${result.total}`
          });
        } else if (action === "clone") {
          const parts = text ? text.split(" ").filter(Boolean) : [];
          const newToken = parts[0];
          const newAdminId = parts[1] || botConfig.adminId;

          if (!newToken) {
            await tgApi(token, "sendMessage", { chat_id: fromId, text: "Token nahi mila, /admin se dobara try karo." });
          } else {
            await ensureBot(newToken, {
              adminId: newAdminId,
              mainChannelUsername: botConfig.mainChannelUsername,
              forwardChannelUsername: botConfig.forwardChannelUsername,
              forwardMessageId: botConfig.forwardMessageId,
              welcomeMessageRef: botConfig.welcomeMessageRef,
              startMessageRef: botConfig.startMessageRef,
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
        }

        return res.send("OK");
      }

      // a tap on the fixed bottom keyboard arrives as plain text matching its label
      const tappedButton = text ? matchConfiguredButton(botConfig, text) : null;
      if (tappedButton) {
        await tgApi(token, "sendMessage", {
          chat_id: fromId,
          text: tappedButton.text,
          reply_markup: { inline_keyboard: [[{ text: "Open", url: tappedButton.url }]] }
        });
        return res.send("OK");
      }

      if (text === "/start" || text === "/admin") {
        if (isAdmin) {
          await tgApi(token, "sendMessage", {
            chat_id: fromId,
            text: "Admin panel:",
            reply_markup: adminPanelKeyboard()
          });
        } else if (text === "/start") {
          await sendStartMessage(token, fromId, botConfig);
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
      mainChannelUsername: MAIN_CHANNEL_USERNAME,
      forwardChannelUsername: FORWARD_CHANNEL_USERNAME,
      forwardMessageId: FORWARD_MESSAGE_ID
    });
    await setWebhook(MAIN_BOT_TOKEN);
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error("Failed to connect to MongoDB:", err);
    process.exit(1);
  });
