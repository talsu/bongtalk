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
Usage : bongtalk --port [num]

Options:
  --port  [required]
```

```bash
$ bongtalk --port 3000
```

### Module
```javascript
var servicePort = 3000;

var BongTalk = require('bongtalk').BongTalk;
var talkServer = new BongTalk(servicePort);
talkServer.start();
```
