var tools = require('./tools');
var Guid = require('guid');
var RequestResponseSocketServer = require('./RequestResponseSocketServer').RequestResponseSocketServer;

exports.SocketHandler = (function(){
	function SocketHandler(database){
		this.database = database;
	}

	SocketHandler.prototype.use = function(sockets){
		var self = this;
		sockets.on('connection', function(socket){
			console.log('connected : ' + socket.id);
			// tools.log(socket);
			var reqServer = new RequestResponseSocketServer(socket);

			reqServer.set('getAllChannel', function (req, res){
				self.database.getAllChannelsKey(function(err, keys){
					console.log(keys);
					res.send({err:err, result:keys})
				});
			});

			reqServer.set('addUserToChannel', function (req, res){
				var channel = req.data.channelId;
				var name = req.data.userName;
				var id = req.data.userId || Guid.create().value;
				self.database.addUserToChannel(channel, id, name, function(err){
					self.database.getUserFromChannel(channel, id, function(err, user){
						res.send({err:err, result:user});	
					});
				});
			});
		});
	};

	return SocketHandler;
})();

//addUserToChannel = function (channelId, userId, userName
