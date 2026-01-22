// notify.js
require("dotenv").config(); // loads .env file into proccess.env so we can work with process.env.DISCORD_TOKEN, etc.
const { Client, GatewayIntentBits, Partials } = require("discord.js"); // pulls items from discord library
// Client: bot connection to Discord.
// GatewayIntentBits: flags that say what types of events/data the bot needs (DMs, guilds, etc.)
// Partials: lets the bot handle “partial” data (useful for DMs)

const { DISCORD_TOKEN, TARGET_USER_ID } = process.env;
if (!DISCORD_TOKEN || !TARGET_USER_ID) {
  throw new Error("Missing DISCORD_TOKEN or TARGET_USER_ID in .env");
}

let _client, _ready; // for each run, dont really know what these do exactly, will read rest of file to find out

async function init(token) {
  if (_client) return _client; // if already exists, return to prevent double
  _client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages], // "Guilds" lets connect to servers, DirectMessages DM functions
    partials: [Partials.Channel], // let DM channels work w partial data
  });
  
  // Note: 'ready' works on v14; when you upgrade to v15, change to 'clientReady'
  _ready = new Promise((res) => _client.once("ready", res));
  await _client.login(token); // login w .env bot token
  await _ready; 
  return _client;
}

async function dmUser(userId, content) {
  if (!_client) throw new Error("Call init() first");
  const user = await _client.users.fetch(userId);
  return user.send(content);
}

module.exports = { init, dmUser };

/* Safe CLI test (won't run when imported) */
if (require.main === module) {
  (async () => {
    try {
      await init(process.env.DISCORD_TOKEN);
      await dmUser(process.env.TARGET_USER_ID, "✅ Test inline send");
      console.log("Test message sent!");
    } catch (err) {
      console.error("Failed to send test:", err.message);
    } finally {
      process.exit(0);
    }
  })();
}
