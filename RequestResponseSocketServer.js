var tools = require('./tools');

exports.RequestResponseSocketServer = (function(){
	function RequestResponseSocketServer(socket){
		var self = this;
		this.callbackMap = {};
		this.socket = socket;
		this.socket.on('request', function(request){
			// tools.log(request);
			var callback = self.callbackMap[request.url];
			if (callback){
				var id = request.id;
				if (id && callback){
					callback(request, new SocketResponse(self.socket, id));	
				}
				else{
					tools.log('can not find id');
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
	function SocketResponse(socket, id){
		this.socket = socket;
		this.id = id;
	}

	SocketResponse.prototype.send = function(data){
		this.socket.emit('response', {id:this.id, data:data});
	};

	return SocketResponse;
})();
