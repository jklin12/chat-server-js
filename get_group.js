import GroupChat from "whatsapp-web.js/src/structures/GroupChat.js";
  
const ch = await client.getChatById(group.gid._serialized);
console.log("chat here", ch);
let gr = new GroupChat(client, ch);

console.log("groupchat", gr);
