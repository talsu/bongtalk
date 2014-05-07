var tools = require('./tools');
var RequestResponseSocketServer = require('./RequestResponseSocketServer').RequestResponseSocketServer;

exports.SocketHandler = (function(){
	function SocketHandler(){}

	SocketHandler.prototype.use = function(socket){
		socket.on('connection', function(err, socket, session){
			console.log('connected');
			tools.log(session);
			var reqServer = new RequestResponseSocketServer(socket);
			reqServer.set('getAllChannel', function (req, res){
				console.log('getAllChannel');
				res.send([{name:'1'}, {name:'2'}]);
			});
			console.log('connected - fin');
		});
	};

	return SocketHandler;
})();
