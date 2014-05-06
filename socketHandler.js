var tools = require('./tools');

exports.SocketHandler = (function(){
	function SocketHandler(){}

	SocketHandler.prototype.use = function(socket){
		socket.on('connection', function(err, socket, session){
			tools.log(session);
			socket.emit('test', {hello : 'world'});
			socket.on('test2', function(data){
				console.log(data);
			});
		});
	};

	return SocketHandler;
})();
