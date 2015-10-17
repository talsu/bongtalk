Bongtalk
========

node.js web chat server.

sample service is running at https://talk.talsu.net and http://bongtalk.herokuapp.com

## Installation

```bash
$ [sudo] npm install bongtalk -g
```


## Usage

### Execute server on command line
```
Usage : bongtalk -p [num] -m [url] -r [url] -s [string]

Options:
  -p, --port        listen port (Default: 3000)
  -m, --mongodb     mongoDB url (Required)
  -r, --redis	    redis url	(Optional for multiple instance)
  -s, --secret      secret string for jsonWebToken(Default: 'defaultSecrect')
```
#### Set config file (config.json)
```json
{
	"servicePort" : "3000",
	"mongodbUrl" : "mongodb://127.0.0.1/bongtalk",
	"secret" : "enterYourSecretString"
}
```
#### Example
```bash
$ bongtalk --port 3000 --mongodb mongodb://127.0.0.1/bongtalk
```
Connect web browser to http://localhost:3000

### Module
```javascript
var BongtalkServer = require('./BongtalkServer').BongtalkServer;

var config = { 
  servicePort: 3000,
  mongodbUrl: 'mongodb://127.0.0.1/bongtalk',
  secret : 'enterYourSecretString'
};

new BongtalkServer(config).run();
// Connect web browser to http://localhost:3000
```
