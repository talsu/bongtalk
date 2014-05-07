var tools = require('./tools');

exports.RequestResponseSocketServer = (function(){
	function RequestResponseSocketServer(socket){
		var self = this;
		this.callbackMap = {};
		this.socket = socket;		
		this.socket.on('request', function(request){
			tools.log(request);
			var callback = self.callbackMap[request.url];
			if (callback){
				var session = request.session;
				if (session && callback){
					callback(request.data, new SocketResponse(self.socket, session));	
				}
				else{
					tools.log('can not find session');
				}
			};
		});
	};

	RequestResponseSocketServer.prototype.set = function(url, callback){
		this.callbackMap[url] = callback;
	};

	return RequestResponseSocketServer;
})();

var SocketResponse = (function(){
	function SocketResponse(socket, session){
		this.socket = socket;
		this.session = session;
	}

	SocketResponse.prototype.send = function(data){
		this.socket.emit('response', {session:this.session, data:data});
	};

	return SocketResponse;
})();