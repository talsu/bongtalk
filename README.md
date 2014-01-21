BongTalk
========

node.js web chat server.

sample service is running at http://bongtalk.herokuapp.com

## Installation

```bash
$ [sudo] npm install bongtalk -g
```


## Usage
### Execute server on command line
```
Usage : bongtalk --port [num] --redisurl [url]

Options:
  -p, --port      listen port
  -r, --redisurl  redis url
  --port                       [required]
```

#### Example
```bash
$ bongtalk --port 3000 --redisurl redis://talsu.net
```
Connect web browser to http://localhost:3000

### Module
```javascript
var servicePort = 3000;
var redisUrl = 'redis://talsu.net/'; // Your redis connection url.

var BongTalk = require('bongtalk').BongTalk;
var talkServer = new BongTalk(servicePort, redisUrl);
talkServer.start();
// Connect web browser to http://localhost:3000
```
