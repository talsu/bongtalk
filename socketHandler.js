var tools = require('./tools');
var Guid = require('guid');
var util = require('util');
var async = require('async');
var EventEmitter = require('events').EventEmitter;
var RequestResponseSocketServer = require('./RequestResponseSocketServer').RequestResponseSocketServer;

exports.SocketHandler = (function(){
	function SocketHandler(database){
		this.database = database;
		this.channelSockets = {};
	}

	util.inherits(SocketHandler, EventEmitter);

	SocketHandler.prototype.use = function(sockets){
		var self = this;
		sockets.on('connection', function(socket){
			console.log('connected : ' + socket.id);

			var channelEventListeners = [];
			var reqServer = new RequestResponseSocketServer(socket);

			reqServer.set('getAllChannel', function (req, res){
				self.database.getAllChannelsKey(function(err, keys){
					console.log(keys);
					res.send({err:err, result:keys})
				});
			});

			reqServer.set('addUserToChannel', function (req, res){
				var channelId = req.data.channelId;
				var name = req.data.userName || 'user';
				var userId = req.data.userId || Guid.create().value;
				self.database.addUserToChannel(channelId, userId, name, function(err){
					self.database.getUserFromChannel(channelId, userId, function(err, user){
						res.send({err:err, result:user});
						self.channelEvent('onAddUser', channelId, user);	
					});
				});
			});

			reqServer.set('joinChannel', function (req, res){
				var channelId = req.data.channelId;
				var userId = req.data.userId;
				async.parallel({
					users: function(callback){ self.database.getUsersFromChannel(channelId, callback);	},
					talks: function(callback){ self.database.getTalkHistory(channelId, callback); }
				},
				function (err, result) {
					if (!err){
						var listener = self.addChannelEventListener(channelId, socket);
						result.connectionId = Guid.create().value;
						channelEventListeners.push({connectionId:result.connectionId, userId:userId, channelId:channelId, listener:listener});
						self.emitUserOnline(result.connectionId, channelId, userId);
					}
					res.send({err:err, result:result})
				});
			});

			reqServer.set('leaveChannel' , function (req, res){
				var connectionId = req.data.connectionId;
				channelEventListeners
				.filter(function(item){return item.connectionId === connectionId;})
				.forEach(function(item){
					self.removeChannelEventListener(item.channelId, item.listener);
					self.emitUserOffline(connectionId, item.channelId, item.userId);
				});
				res.send({err:null, result:'done'});
			});

			reqServer.set('getTalkHistory', function (req, res){
				var channelId = req.data.channelId;
				self.database.getTalkHistory(channelId, function(err, result){
					res.send({err:err, result:result});
				});
			});

			reqServer.set('getUsersFromChannel', function (req, res){
				var channelId = req.data.channelId;
				self.database.getUsersFromChannel(channelId, function(err, result){
					res.send({err:err, result:result});
				});
			});

			reqServer.set('getUserFromChannel', function (req, res){
				var channelId = req.data.channelId;
				var userId = req.data.userId;
				if (!channelId){
					res.send({err:'bad channelId', result:null});
				}
				if (!userId){
					res.send({err:'bad userId', result:null})
				}
				self.database.getUserFromChannel(channelId, userId, function(err, user){
					res.send({err:err, result:user});	
				});
			});

			reqServer.set('addNewTalk', function (req, res){
				var channelId = req.data.channelId;
				var talk = {
					id: Guid.create().value,					
					time : new Date(),
					message : req.data.message,
					user : req.data.user
				}
				
				self.database.addTalkHistory(channelId, talk, function(err, result){
					res.send({err:err, result:talk});
					self.channelEvent('onNewTalk', channelId, talk);
				});
			});

			socket.on('disconnect', function () {
				console.log('disconnect');
				channelEventListeners.forEach(function(item){
					self.removeChannelEventListener(item.channelId, item.listener);
					self.emitUserOffline(item.connectionId, item.channelId, item.userId);
				});
			});
		});

		SocketHandler.prototype.channelEvent = function(eventName, channelId, data){
			var eventArg = {eventName:eventName, channelData:{channelId:channelId, data:data}};
			this.emit('channelEvent-' + channelId, eventArg);
		};

		SocketHandler.prototype.addChannelEventListener = function(channelId, socket){
			var listener = function (eventArg){ socket.emit(eventArg.eventName, eventArg.channelData); };
			var eventId = 'channelEvent-' + channelId;
			this.on(eventId, listener);
			console.log('addChannelEventListener('+this.listeners(eventId).length+') : ' + eventId)
			return listener;
		};

		SocketHandler.prototype.removeChannelEventListener = function(channelId, listener){
			var eventId = 'channelEvent-' + channelId;
			this.removeListener(eventId, listener);

			console.log('removeChannelEventListener('+this.listeners(eventId).length+') : ' + eventId)
		};

		SocketHandler.prototype.emitUserOnline = function(connectionId, channelId, userId){
			this.setUserOnOffline(true, connectionId, channelId, userId);
		};

		SocketHandler.prototype.emitUserOffline = function(connectionId, channelId, userId){
			this.setUserOnOffline(false, connectionId, channelId, userId);
		};

		SocketHandler.prototype.setUserOnOffline = function(isOnline, connectionId, channelId, userId){
			var self = this;
			async.waterfall([
				function (callback){ self.database[isOnline ? 'setUserOnline' : 'setUserOffline'](connectionId, channelId, userId, callback); },
				function (result, callback) { self.database.getUserConnections(channelId, userId, callback); },
			], function (err, result){
				if (!err){
					self.channelEvent('onUpdateUser', channelId, {
						userId:userId,
						propertyName:'connections',
						data:result
					});
				}
			});
		};
	};


	return SocketHandler;
})();

//addUserToChannel = function (channelId, userId, userName
