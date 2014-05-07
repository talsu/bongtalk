var tools = require('./tools');
var RequestResponseSocketServer = require('./RequestResponseSocketServer').RequestResponseSocketServer;

exports.SocketHandler = (function(){
	function SocketHandler(database){
		this.database = database;
	}

	SocketHandler.prototype.use = function(sockets){
		var self = this;
		sockets.on('connection', function(socket){
			console.log('connected');
			// tools.log(socket);
			var reqServer = new RequestResponseSocketServer(socket);

			reqServer.set('getAllChannel', function (req, res){
				self.database.getAllChannelsKey(function(err, keys){
					console.log(keys);
					res.send({err:err, result:keys})
				});
//				res.send([{name:'channel 1', age:9}, {name:'channel 2', age:3}]);
			});

			reqServer.set('addUserToChannel', function (req, res){
				var channelId = req.data.channel;
				var name = req.data.name;
				var id = socket.id;
				self.database.addUserToChannel(channelId, id, name, function(err){
					res.send({err:err, result:id});
				});
			});

			socket.emit('connected', {});
		});
	};

	return SocketHandler;
})();

//addUserToChannel = function (channelId, userId, userName
