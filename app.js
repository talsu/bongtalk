var http = require('http');
var path = require('path');
var util = require('util');
var express = require('express');
var logger = require('morgan');
var bodyParser = require('body-parser');
var cookieParser = require('cookie-parser');
var methodOverride = require('method-override');
var errorhandler = require('errorhandler');
var session = require('express-session');

var Sockets = require('socket.io');
var SessionSockets = require('session.socket.io');

var RedisStore = require('connect-redis')(session);

var tools = require('./tools');
var SocketHandler = require('./socketHandler').SocketHandler;
var RedisDatabase = require('./RedisDatabase').RedisDatabase;

// var models = require('./models');
// var RedisDatabase = models.RedisDatabase;
// var JadeDataBinder = models.JadeDataBinder;

var secretString = 'bongtalkSecret';

var BongTalkServer = (function(){
	function BongTalkServer(servicePort, redisUrl){
		this.servicePort = process.env.PORT || servicePort;
		this.redisUrl = redisUrl;
		this.sessionStore = new RedisStore({client:tools.createRedisClient(this.redisUrl)});
		this.cookieParser = cookieParser(secretString);
		this.database = new RedisDatabase(tools.createRedisClient(this.redisUrl), 'db');
	}

	BongTalkServer.prototype.run = function(){
		var self = this;
		var app = express();
		app.use(logger('dev'));
		app.use(express.static(__dirname + '/public'));
		app.use(bodyParser());
		app.use(methodOverride());
		app.use(this.cookieParser);
		app.use(session({ store: this.sessionStore, key: 'jsessionid', secret: secretString }));

		app.use(errorhandler());
		// app.use(function(req, res){
		// 	res.send('Hello');
		// });

		// app.get('/', function(req, res){
		// 	res.send('hello world');
		// });
		var server = http.createServer(app);
        server.listen(this.servicePort);

		var io = Sockets.listen(server);
		io.set('log level', 2);

		// var sessionSockets = new SessionSockets(io, this.sessionStore, this.cookieParser, 'jsessionid');
		var socketHandler = new SocketHandler(this.databases);
		socketHandler.use(io.sockets);
	};


	return BongTalkServer;
})();

var server = new BongTalkServer(3000, 'redis://talsu.net');
server.run();
