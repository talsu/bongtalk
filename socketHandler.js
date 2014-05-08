var tools = require('./tools');
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
				var channl = req.data.channel;
				var name = req.data.name;
				var id = socket.id;
				self.database.addUserToChannel(channl, id, name, function(err){
					res.send({err:err, result:id});
				});
			});
		});
	};

	return SocketHandler;
})();

//addUserToChannel = function (channelId, userId, userName
