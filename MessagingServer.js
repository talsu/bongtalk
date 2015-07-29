var util = require('util');
var Sockets = require('socket.io');
var tools = require('./tools');

exports.MessagingServer = (function(){
	function MessagingServer (listenTarget, option, adapter)	{
		var self = this;

		var io = Sockets(listenTarget, option);		
		if (adapter) io.adapter(adapter);

		//self.io.path('/messaging');

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

			// var rpServer = new RequestResponseSocketServer(socket)
			// .set('join', function (sessionId){								
			// 	socket.join(sessionId);
			// 	tools.log('joinSession -'+ ' (sessionId: ' + sessionId + ')');
			// 	res.send({err:null, result:{talks:[]}});
			// })
			// .set('addNewTalk', function (req, res){
			// 	tools.log('addNewTalk -' + util.inspect(req.data));
			// 	sessionEvent('onNewTalk', req.data.sessionId, req.data);
			// 	res.send({err:null, result:req.data});
			// });

			// function sessionEvent(eventName, sessionId, data){
			// 	var eventArg = {eventName:eventName, sessionData:{sessionId:sessionId, data:data}};				
			// 	socket.broadcast.to(sessionId).emit('sessionEvent', eventArg);
			// }

			socket.on('disconnect', function () {
				tools.log('disconnect - ' + ' (socketId: ' + socket.id + ' )');
			});
		});
	}

	return MessagingServer;
})();