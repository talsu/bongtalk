var http = require('http');
var path = require('path');
var util = require('util');
var Guid = require('guid');
var async = require('async');
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

		var app = express();
		app.use(logger('dev'));
		app.use(express.static(__dirname + '/public'));
		app.set('views', __dirname + '/public');
		app.set("view options", {layout: false});
		app.use(bodyParser.urlencoded({ extended: false }));
		app.use(bodyParser.json());
		app.use(methodOverride());
		app.use(this.cookieParser);
		app.use(errorhandler());
		app.engine('html', require('ejs').renderFile);
		app.get('/isAlive', function (req, res){res.send();});
		app.get('/p', function (req, res){ res.render('popup.html'); });

		app.get('/getAllChannel', function (req, res) {
			tools.pLog('getAllChannel');
			self.database.getAllChannelsKey(function(err, keys){					
				res.send({err:err, result:keys})
			});			
		});

		app.post('/addUserToChannel', function (req, res){				
			var channelId = req.data.channelId;
			var name = req.data.userName || ('user' + Math.floor((Math.random() * 1000) + 100));
			var userId = req.data.userId || Guid.create().value;
			tools.pLog('addUserToChannel -' + ' (channelId: ' + channelId + ')');

			self.database.addUserToChannel(channelId, userId, name, function(err){
				self.database.getUserFromChannel(channelId, userId, function(err, user){
					res.send({err:err, result:user});					
				});
			});
		});

		app.post('/joinChannel', function (req, res){				
			var channelId = req.data.channelId;
			var userId = req.data.userId;

			async.parallel({
				users: function(callback){ self.database.getUsersFromChannel(channelId, callback);	},
				talks: function(callback){ self.database.getTalkHistory(channelId, callback); }
			},
			function (err, result) {
				if (!err){
					result.connectionId = Guid.create().value;											
					tools.pLog('joinChannel -'+ ' (channelId: ' + channelId + ')' + ' (sockets: ' + util.inspect(self.socketCounter) + ')');
				}
				res.send({err:err, result:result})
			});
		})

		app.post('/leaveChannel' , function (req, res){				
			var connectionId = req.data.connectionId;				
			tools.pLog('leaveChannel -' + ' (sockets: ' + util.inspect(self.socketCounter) + ')');
			res.send({err:null, result:'done'});
		});

		app.post('getTalkHistory', function (req, res){
			var channelId = req.data.channelId;
			tools.pLog('getTalkHistory -' + ' (channelId: ' + channelId + ')');
			
			self.database.getTalkHistory(channelId, function(err, result){
				res.send({err:err, result:result});
			});
		});

		app.post('clearTalkHistory', function (req, res){
			var channelId = req.data.channelId;
			tools.pLog('clearTalkHistory -' + ' (channelId: ' + channelId + ')');

			self.database.clearTalkHistory(channelId, function(err, result){
				res.send({err:err, result:result});
			});
		});

		app.post('clearUser', function (req, res){
			var channelId = req.data.channelId;
			tools.pLog('clearTalkHistory -' + ' (channelId: ' + channelId + ')');

			self.database.clearAllUserInChannel(channelId, function(err, result){
				res.send({err:err, result:result});
			});
		});

		app.post('getUsersFromChannel', function (req, res){
			var channelId = req.data.channelId;
			tools.pLog('getUsersFromChannel -' + ' (channelId: ' + channelId + ')');
			
			self.database.getUsersFromChannel(channelId, function(err, result){
				res.send({err:err, result:result});
			});
		});

		app.post('getUserFromChannel', function (req, res){				
			var channelId = req.data.channelId;
			var userId = req.data.userId;
			tools.pLog('getUserFromChannel -' + ' (channelId: ' + channelId + ')' + ' (userId: ' + userId + ')');
			
			if (!channelId){
				res.send({err:'bad channelId', result:null});
			}
			if (!userId){
				res.send({err:'bad userId', result:null});
			}
			
			self.database.getUserFromChannel(channelId, userId, function(err, user){
				res.send({err:err, result:user});	
			});
		});

		app.post('addNewTalk', function (req, res){
			var channelId = req.data.channelId;
			var talk = {
				id: Guid.create().value,					
				time : new Date(),
				message : req.data.message,
				userId : req.data.userId
			}
			tools.pLog('addNewTalk -' + ' (channelId: ' + channelId + ')' + ' (userId: ' + talk.userId + ')');
			
			self.database.addTalkHistory(channelId, talk, function(err, result){
				res.send({err:err, result:talk});				
			});
		});

		app.post('updateUser', function (req, res){
			var channelId = req.data.channelId;
			var userId = req.data.userId;
			var propertyName = req.data.propertyName;
			var data = req.data.data;

			if (channelId && userId && propertyName){
				self.database.setUserProperty(channelId, userId, propertyName, data, function (err, result){
					if (err){
						res.send({err:err, result:null});
					}
					else{
						var result = {
							userId:userId,
							propertyName:propertyName,
							data:data
						};
						res.send({err:err, result:result});						
					}
				});
			};
		});

		var server = http.createServer(app);
		server.listen(this.servicePort);

		listenTarget = server;

		
		var transports = this.option.websocket ? ['websocket', 'polling'] : ['polling'];
		new QufoxServer(listenTarget, {transports:transports}, socketRedisAdapter(this.socketRedisAdapterOption));
	};


	return BongtalkServer;
})();