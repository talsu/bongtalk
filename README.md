BongTalk
========

node.js web chat server.

````javascript
var servicePort = 3000;

var BongTalk = require('../').BongTalk;
var talkServer = new BongTalk(servicePort);
talkServer.start();
````