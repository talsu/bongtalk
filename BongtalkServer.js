var http = require('http');
var path = require('path');
var util = require('util');
var Guid = require('guid');
var express = require('express');
var logger = require('morgan');
var bodyParser = require('body-parser');
var cookieParser = require('cookie-parser');
var methodOverride = require('method-override');
var errorhandler = require('errorhandler');
var redis = require("redis");
var Sockets = require('socket.io');
var socketRedisAdapter = require('socket.io-redis');

var tools = require('./tools');
var SocketHandler = require('./socketHandler').SocketHandler;
var RedisDatabase = require('./RedisDatabase').RedisDatabase;

var QufoxServer = require('./QufoxServer').QufoxServer;

var secretString = 'bongtalkSecret';

exports.BongtalkServer = (function(){
	function BongtalkServer(option){
		this.option = option;
		this.servicePort = process.env.PORT || option.servicePort;
		this.redisUrl = option.redisUrl;
		this.cookieParser = cookieParser(secretString);
		this.database = new RedisDatabase(tools.createRedisClient(this.redisUrl), Guid.create().value);
		this.socketRedisAdapterOption = {
			pubClient : tools.createRedisClient(this.redisUrl, {return_buffers:true}),
			subClient : tools.createRedisClient(this.redisUrl, {return_buffers:true})
		};
	}

	BongtalkServer.prototype.run = function(){
		var self = this;

		var listenTarget = this.servicePort;

		if (!this.option.isSocketOnly){
			var app = express();
			app.use(logger('dev'));
			app.use(express.static(__dirname + '/public'));
			app.set('views', __dirname + '/public');
			app.set("view options", {layout: false});
			app.use(bodyParser());
			app.use(methodOverride());
			app.use(this.cookieParser);
			app.use(errorhandler());
	  		app.engine('html', require('ejs').renderFile);
			app.get('/isAlive', function (req, res){res.send();});
			app.get('/p', function (req, res){ res.render('popup.html'); });

			var server = http.createServer(app);
	        server.listen(this.servicePort);

	        listenTarget = server;
		}

		var transports = this.option.websocket ? ['websocket', 'polling'] : ['polling'];
		// var io = Sockets(listenTarget, {transports:transports});
		// io.adapter(socketRedisAdapter(this.socketRedisAdapterOption));

		// var socketHandler = new SocketHandler(this.database);

		// socketHandler.use(io.sockets);

		new QufoxServer(listenTarget, {transports:transports}, socketRedisAdapter(this.socketRedisAdapterOption));
	};


	return BongtalkServer;
})();