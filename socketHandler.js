var tools = require('./tools');
var Guid = require('guid');
var util = require('util');
var async = require('async');
var EventEmitter = require('events').EventEmitter;
var RequestResponseSocketServer = require('./RequestResponseSocketServer').RequestResponseSocketServer;

exports.SocketHandler = (function(){
	function SocketHandler(database){
		this.database = database;
		this.socketCounter = { connected:0, joined:0 };
	}

	util.inherits(SocketHandler, EventEmitter);

	SocketHandler.prototype.use = function(sockets){
		var self = this;
		sockets.on('connection', function(err, socket, session){ //for sessionSocket
		//sockets.on('connection', function(socket){ //for regular socket
			socket.emit('connected');
			self.socketCounter.connected++;		
			tools.pLog('connected -' + ' (socketId: ' + socket.id + ')' + ' (sockets: ' + util.inspect(self.socketCounter) + ')');

			var connections = [];
			var reqServer = new RequestResponseSocketServer(socket);

			reqServer.set('getAllChannel', function (req, res){
				tools.pLog('getAllChannel');
				self.database.getAllChannelsKey(function(err, keys){					
					res.send({err:err, result:keys})
				});
			});

			reqServer.set('addUserToChannel', function (req, res){				
				var channelId = req.data.channelId;
				var name = req.data.userName || 'user';
				var userId = req.data.userId || Guid.create().value;
				tools.pLog('addUserToChannel -' + ' (channelId: ' + channelId + ')');

				self.database.addUserToChannel(channelId, userId, name, function(err){
					self.database.getUserFromChannel(channelId, userId, function(err, user){
						res.send({err:err, result:user});
						channelEvent('onAddUser', channelId, user);	
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
						// socket.join(channelId);
						// var listener = self.addChannelEventListener(channelId, socket.id);
						result.connectionId = Guid.create().value;						
						emitUserOnline(result.connectionId, channelId, userId);
						tools.pLog('joinChannel -'+ ' (channelId: ' + channelId + ')' + ' (sockets: ' + util.inspect(self.socketCounter) + ')');
					}
					res.send({err:err, result:result})
				});
			});

			reqServer.set('leaveChannel' , function (req, res){				
				var connectionId = req.data.connectionId;
				emitUserOffline(connectionId);
				tools.pLog('leaveChannel -' + ' (sockets: ' + util.inspect(self.socketCounter) + ')');
				res.send({err:null, result:'done'});
			});

			reqServer.set('getTalkHistory', function (req, res){
				var channelId = req.data.channelId;
				tools.pLog('getTalkHistory -' + ' (channelId: ' + channelId + ')');
				
				self.database.getTalkHistory(channelId, function(err, result){
					res.send({err:err, result:result});
				});
			});

			reqServer.set('getUsersFromChannel', function (req, res){
				var channelId = req.data.channelId;
				tools.pLog('getUsersFromChannel -' + ' (channelId: ' + channelId + ')');
				
				self.database.getUsersFromChannel(channelId, function(err, result){
					res.send({err:err, result:result});
				});
			});

			reqServer.set('getUserFromChannel', function (req, res){				
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

			reqServer.set('addNewTalk', function (req, res){
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
					channelEvent('onNewTalk', channelId, talk);
				});
			});

			reqServer.set('updateUser', function (req, res){
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
							channelEvent('onUpdateUser', channelId, result);
						}
					});
				};
			});

			socket.on('disconnect', function () {
				connections
					.map(function (item){return item.connectionId;})
					.forEach(function (connectionId){
						emitUserOffline(connectionId);
					});
				self.socketCounter.connected--;
				tools.pLog('disconnect -' + ' (socketId: ' + socket.id + ')' + ' (sockets: ' + util.inspect(self.socketCounter) + ')');
			});

			function channelEvent(eventName, channelId, data){
				var eventArg = {eventName:eventName, channelData:{channelId:channelId, data:data}};				
				socket.broadcast.to(channelId).emit('channelEvent', eventArg);
			}

			function emitUserOnline(connectionId, channelId, userId){				
				socket.join(channelId);
				self.socketCounter.joined++;
				connections.push({connectionId:connectionId, userId:userId, channelId:channelId});
				setUserOnOffline(true, connectionId, channelId, userId);
			}

			function emitUserOffline(connectionId){
				connections
					.filter(function (connection){return connection.connectionId === connectionId})
					.forEach(function (connection){						
						setUserOnOffline(false, connectionId, connection.channelId, connection.userId, function(){
							connections.splice(connections.indexOf(connection), 1);
							if (getConnectionsByChannelId(connection.channelId).length === 0){								
								socket.leave(connection.channelId);								
							}
						});
						self.socketCounter.joined--;
					});
			}

			function getConnectionsByChannelId(channelId){
				return connections.filter(function (connection){return connection.channelId === channelId});
			}

			function setUserOnOffline(isOnline, connectionId, channelId, userId, callback){				
				async.waterfall([
					function (callback){ self.database[isOnline ? 'setUserOnline' : 'setUserOffline'](connectionId, channelId, userId, callback); },
					function (result, callback) { self.database.getUserConnections(channelId, userId, callback); },
				], function (err, result){
					if (!err){
						console.log('onUpdateUser');
						channelEvent('onUpdateUser', channelId, {
							userId:userId,
							propertyName:'connections',
							data:result.length
						});
					}

					if (callback){
						callback(err, result);
					}
				});
			}

			function leaveAllRoom(){
				var rooms = sockets.manager.roomClients[socket.id];
				for (var channelId in rooms) {
					if (channelId.length > 0) { // if not the global room ''
						channelId = channelId.substr(1); // remove leading '/'												
						socket.leave(channelId);
					}
				}
			}
		});
	};


	return SocketHandler;
})();