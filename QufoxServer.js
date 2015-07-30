var util = require('util');
var Sockets = require('socket.io');
var tools = require('./tools');

exports.QufoxServer = (function(){
	function QufoxServer (listenTarget, option, adapter)	{
		var self = this;

		var io = Sockets(listenTarget, option);		
		if (adapter) io.adapter(adapter);

		io.on('connection', function (socket){			
			tools.log('connected - ' + ' (socketId: ' + socket.id + ' )');
			socket.emit('connected');
			
			socket.on('join', function (sessionId) {
				socket.join(sessionId);
				tools.log('joinSession -'+ ' (sessionId: ' + sessionId + ')');
				socket.emit('joinCallback', {id:sessionId, data:'success'});
			});

			socket.on('send', function (payload) {
				if (payload && payload.sessionId && payload.id) {
					tools.log('send -' + util.inspect(payload));
					socket.broadcast.to(payload.sessionId).emit('receive', {id:payload.sessionId, data:payload.data});
					socket.emit('sendCallback', {id:payload.id, data:'success'});
				}
			});

			socket.on('leave', function (sessionId) {
				socket.leave(sessionId);
				tools.log('leaveSession -'+ ' (sessionId: ' + sessionId + ')');
				socket.emit('leaveCallback', {id:sessionId, data:'success'});
			});

			socket.on('disconnect', function () {
				tools.log('disconnect - ' + ' (socketId: ' + socket.id + ' )');
			});
		});
	}

	return QufoxServer;
})();