// notify/index.js
const { sendDesktop } = require("./desktop_channel");

async function send({ channel = "desktop", title, message, ...rest }) {
  if (channel === "desktop") {
    return sendDesktop(title, message, rest);
  }
  // Future: 'discord', 'sms', 'voice' etc.
}

module.exports = { send };
