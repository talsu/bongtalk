'use strict';

define(['modules/uuid'], function(uuid){
	function RequestResponseSocketClient(socket){
		var self = this;
		this.callbackMap = {};
		this.socket = socket;
		this.socket.on('response', function(response){
			var callback = self.callbackMap[response.session];
			if (callback){
				delete self.callbackMap[response.session];
				callback(response.data);
			};
		});
	};

	RequestResponseSocketClient.prototype.request = function(url, data, callback){
		var session = uuid();
		var request = {session:session, url:url, data:data};
		this.callbackMap[session] = callback;
		this.socket.emit('request', request);
	};

	return RequestResponseSocketClient;
});
